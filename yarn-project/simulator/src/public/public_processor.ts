import {
  type FailedTx,
  MerkleTreeId,
  type MerkleTreeWriteOperations,
  NestedProcessReturnValues,
  type ProcessedTx,
  type ProcessedTxHandler,
  PublicKernelPhase,
  Tx,
  type TxValidator,
  makeProcessedTxFromPrivateOnlyTx,
  makeProcessedTxFromTxWithPublicCalls,
} from '@aztec/circuit-types';
import {
  ContractClassRegisteredEvent,
  type ContractDataSource,
  Fr,
  Gas,
  type GlobalVariables,
  type Header,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  NULLIFIER_SUBTREE_HEIGHT,
  PUBLIC_DATA_SUBTREE_HEIGHT,
  PublicDataWrite,
} from '@aztec/circuits.js';
import { padArrayEnd } from '@aztec/foundation/collection';
import { createDebugLogger } from '@aztec/foundation/log';
import { Timer } from '@aztec/foundation/timer';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { Attributes, type TelemetryClient, type Tracer, trackSpan } from '@aztec/telemetry-client';

import { type SimulationProvider } from '../providers/index.js';
import { EnqueuedCallsProcessor } from './enqueued_calls_processor.js';
import { PublicExecutor } from './executor.js';
import { computeFeePayerBalanceLeafSlot, computeFeePayerBalanceStorageSlot } from './fee_payment.js';
import { WorldStateDB } from './public_db_sources.js';
import { RealPublicKernelCircuitSimulator } from './public_kernel.js';
import { type PublicKernelCircuitSimulator } from './public_kernel_circuit_simulator.js';
import { PublicProcessorMetrics } from './public_processor_metrics.js';

/**
 * Creates new instances of PublicProcessor given the provided merkle tree db and contract data source.
 */
export class PublicProcessorFactory {
  constructor(
    private contractDataSource: ContractDataSource,
    private simulator: SimulationProvider,
    private telemetryClient: TelemetryClient,
  ) {}

  /**
   * Creates a new instance of a PublicProcessor.
   * @param historicalHeader - The header of a block previous to the one in which the tx is included.
   * @param globalVariables - The global variables for the block being processed.
   * @returns A new instance of a PublicProcessor.
   */
  public create(
    merkleTree: MerkleTreeWriteOperations,
    maybeHistoricalHeader: Header | undefined,
    globalVariables: GlobalVariables,
  ): PublicProcessor {
    const { telemetryClient } = this;
    const historicalHeader = maybeHistoricalHeader ?? merkleTree.getInitialHeader();

    const worldStateDB = new WorldStateDB(merkleTree, this.contractDataSource);
    const publicExecutor = new PublicExecutor(worldStateDB, telemetryClient);
    const publicKernelSimulator = new RealPublicKernelCircuitSimulator(this.simulator);

    return PublicProcessor.create(
      merkleTree,
      publicExecutor,
      publicKernelSimulator,
      globalVariables,
      historicalHeader,
      worldStateDB,
      this.telemetryClient,
    );
  }
}

/**
 * Converts Txs lifted from the P2P module into ProcessedTx objects by executing
 * any public function calls in them. Txs with private calls only are unaffected.
 */
export class PublicProcessor {
  private metrics: PublicProcessorMetrics;
  constructor(
    protected db: MerkleTreeWriteOperations,
    protected publicExecutor: PublicExecutor,
    protected publicKernel: PublicKernelCircuitSimulator,
    protected globalVariables: GlobalVariables,
    protected historicalHeader: Header,
    protected worldStateDB: WorldStateDB,
    protected enqueuedCallsProcessor: EnqueuedCallsProcessor,
    telemetryClient: TelemetryClient,
    private log = createDebugLogger('aztec:sequencer:public-processor'),
  ) {
    this.metrics = new PublicProcessorMetrics(telemetryClient, 'PublicProcessor');
  }

  static create(
    db: MerkleTreeWriteOperations,
    publicExecutor: PublicExecutor,
    publicKernelSimulator: PublicKernelCircuitSimulator,
    globalVariables: GlobalVariables,
    historicalHeader: Header,
    worldStateDB: WorldStateDB,
    telemetryClient: TelemetryClient,
  ) {
    const enqueuedCallsProcessor = EnqueuedCallsProcessor.create(
      db,
      publicExecutor,
      publicKernelSimulator,
      globalVariables,
      historicalHeader,
      worldStateDB,
    );

    return new PublicProcessor(
      db,
      publicExecutor,
      publicKernelSimulator,
      globalVariables,
      historicalHeader,
      worldStateDB,
      enqueuedCallsProcessor,
      telemetryClient,
    );
  }

  get tracer(): Tracer {
    return this.metrics.tracer;
  }

  /**
   * Run each tx through the public circuit and the public kernel circuit if needed.
   * @param txs - Txs to process.
   * @param processedTxHandler - Handler for processed txs in the context of block building or proving.
   * @returns The list of processed txs with their circuit simulation outputs.
   */
  public async process(
    txs: Tx[],
    maxTransactions = txs.length,
    processedTxHandler?: ProcessedTxHandler,
    txValidator?: TxValidator<ProcessedTx>,
  ): Promise<[ProcessedTx[], FailedTx[], NestedProcessReturnValues[]]> {
    // The processor modifies the tx objects in place, so we need to clone them.
    txs = txs.map(tx => Tx.clone(tx));
    const result: ProcessedTx[] = [];
    const failed: FailedTx[] = [];
    let returns: NestedProcessReturnValues[] = [];

    for (const tx of txs) {
      // only process up to the limit of the block
      if (result.length >= maxTransactions) {
        break;
      }
      try {
        const [processedTx, returnValues] = !tx.hasPublicCalls()
          ? await this.processPrivateOnlyTx(tx)
          : await this.processTxWithPublicCalls(tx);
        this.log.debug(`Processed tx`, {
          txHash: processedTx.hash,
          historicalHeaderHash: processedTx.constants.historicalHeader.hash(),
          blockNumber: processedTx.constants.globalVariables.blockNumber,
          lastArchiveRoot: processedTx.constants.historicalHeader.lastArchive.root,
        });

        // Commit the state updates from this transaction
        await this.worldStateDB.commit();

        // Re-validate the transaction
        if (txValidator) {
          // Only accept processed transactions that are not double-spends,
          // public functions emitting nullifiers would pass earlier check but fail here.
          // Note that we're checking all nullifiers generated in the private execution twice,
          // we could store the ones already checked and skip them here as an optimization.
          const [_, invalid] = await txValidator.validateTxs([processedTx]);
          if (invalid.length) {
            throw new Error(`Transaction ${invalid[0].hash} invalid after processing public functions`);
          }
        }
        // if we were given a handler then send the transaction to it for block building or proving
        if (processedTxHandler) {
          await processedTxHandler.addNewTx(processedTx);
        }
        // Update the state so that the next tx in the loop has the correct .startState
        // NB: before this change, all .startStates were actually incorrect, but the issue was never caught because we either:
        // a) had only 1 tx with public calls per block, so this loop had len 1
        // b) always had a txHandler with the same db passed to it as this.db, which updated the db in buildBaseRollupHints in this loop
        // To see how this ^ happens, move back to one shared db in test_context and run orchestrator_multi_public_functions.test.ts
        // The below is taken from buildBaseRollupHints:
        await this.db.appendLeaves(
          MerkleTreeId.NOTE_HASH_TREE,
          padArrayEnd(processedTx.txEffect.noteHashes, Fr.ZERO, MAX_NOTE_HASHES_PER_TX),
        );
        try {
          await this.db.batchInsert(
            MerkleTreeId.NULLIFIER_TREE,
            padArrayEnd(processedTx.txEffect.nullifiers, Fr.ZERO, MAX_NULLIFIERS_PER_TX).map(n => n.toBuffer()),
            NULLIFIER_SUBTREE_HEIGHT,
          );
        } catch (error) {
          if (txValidator) {
            // Ideally the validator has already caught this above, but just in case:
            throw new Error(`Transaction ${processedTx.hash} invalid after processing public functions`);
          } else {
            // We have no validator and assume this call should blindly process txs with duplicates being caught later
            this.log.warn(`Detected duplicate nullifier after public processing for: ${processedTx.hash}.`);
          }
        }

        const allPublicDataWrites = padArrayEnd(
          processedTx.txEffect.publicDataWrites,
          PublicDataWrite.empty(),
          MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
        );
        await this.db.batchInsert(
          MerkleTreeId.PUBLIC_DATA_TREE,
          allPublicDataWrites.map(x => x.toBuffer()),
          PUBLIC_DATA_SUBTREE_HEIGHT,
        );
        result.push(processedTx);
        returns = returns.concat(returnValues ?? []);
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        this.log.warn(`Failed to process tx ${tx.getTxHash()}: ${errorMessage} ${err?.stack}`);

        failed.push({
          tx,
          error: err instanceof Error ? err : new Error(errorMessage),
        });
        returns.push(new NestedProcessReturnValues([]));
      }
    }

    return [result, failed, returns];
  }

  /**
   * Creates the final set of data update requests for the transaction. This includes the
   * set of public data update requests as returned by the public kernel, plus a data update
   * request for updating fee balance. It also updates the local public state db.
   * See build_or_patch_payment_update_request in base_rollup_inputs.nr for more details.
   */
  private async getFeePaymentPublicDataWrite(
    publicDataWrites: PublicDataWrite[],
    txFee: Fr,
    feePayer: Fr,
  ): Promise<PublicDataWrite | undefined> {
    if (feePayer.isZero()) {
      return;
    }

    const feeJuiceAddress = ProtocolContractAddress.FeeJuice;
    const balanceSlot = computeFeePayerBalanceStorageSlot(feePayer);
    const leafSlot = computeFeePayerBalanceLeafSlot(feePayer);

    this.log.debug(`Deducting ${txFee} balance in Fee Juice for ${feePayer}`);

    const existingBalanceWrite = publicDataWrites.find(write => write.leafSlot.equals(leafSlot));

    const balance = existingBalanceWrite
      ? existingBalanceWrite.value
      : await this.worldStateDB.storageRead(feeJuiceAddress, balanceSlot);

    if (balance.lt(txFee)) {
      throw new Error(`Not enough balance for fee payer to pay for transaction (got ${balance} needs ${txFee})`);
    }

    const updatedBalance = balance.sub(txFee);
    await this.worldStateDB.storageWrite(feeJuiceAddress, balanceSlot, updatedBalance);

    return new PublicDataWrite(leafSlot, updatedBalance);
  }

  private async processPrivateOnlyTx(tx: Tx): Promise<[ProcessedTx]> {
    const txData = tx.data.toKernelCircuitPublicInputs();

    const gasFees = this.globalVariables.gasFees;
    const transactionFee = txData.end.gasUsed
      .computeFee(gasFees)
      .add(txData.constants.txContext.gasSettings.inclusionFee);

    const feePaymentPublicDataWrite = await this.getFeePaymentPublicDataWrite(
      txData.end.publicDataWrites,
      transactionFee,
      txData.feePayer,
    );

    const processedTx = makeProcessedTxFromPrivateOnlyTx(
      tx,
      transactionFee,
      feePaymentPublicDataWrite,
      this.globalVariables,
    );
    return [processedTx];
  }

  @trackSpan('PublicProcessor.processTxWithPublicCalls', tx => ({
    [Attributes.TX_HASH]: tx.getTxHash().toString(),
  }))
  private async processTxWithPublicCalls(tx: Tx): Promise<[ProcessedTx, NestedProcessReturnValues[]]> {
    const timer = new Timer();

    const {
      avmProvingRequest,
      returnValues,
      revertCode,
      revertReason,
      gasUsed: phaseGasUsed,
      processedPhases,
    } = await this.enqueuedCallsProcessor.process(tx);

    if (!avmProvingRequest) {
      this.metrics.recordFailedTx();
      throw new Error('Avm proving result was not generated.');
    }

    processedPhases.forEach(phase => {
      if (phase.revertReason) {
        this.metrics.recordRevertedPhase(phase.phase);
      } else {
        this.metrics.recordPhaseDuration(phase.phase, phase.durationMs);
      }
    });

    this.metrics.recordClassRegistration(
      ...ContractClassRegisteredEvent.fromLogs(
        tx.unencryptedLogs.unrollLogs(),
        ProtocolContractAddress.ContractClassRegisterer,
      ),
    );

    const phaseCount = processedPhases.length;
    this.metrics.recordTx(phaseCount, timer.ms());

    const data = avmProvingRequest.inputs.output;
    const feePaymentPublicDataWrite = await this.getFeePaymentPublicDataWrite(
      data.accumulatedData.publicDataWrites,
      data.transactionFee,
      tx.data.feePayer,
    );

    const privateGasUsed = tx.data.forPublic!.revertibleAccumulatedData.gasUsed.add(
      tx.data.forPublic!.nonRevertibleAccumulatedData.gasUsed,
    );
    const publicGasUsed = Object.values(phaseGasUsed).reduce((total, gas) => total.add(gas), Gas.empty());
    const gasUsed = {
      totalGas: privateGasUsed.add(publicGasUsed),
      teardownGas: phaseGasUsed[PublicKernelPhase.TEARDOWN] ?? Gas.empty(),
    };

    const processedTx = makeProcessedTxFromTxWithPublicCalls(
      tx,
      avmProvingRequest,
      feePaymentPublicDataWrite,
      gasUsed,
      revertCode,
      revertReason,
    );

    return [processedTx, returnValues];
  }
}
