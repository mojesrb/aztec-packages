use crate::{
    abis::{
        accumulated_data::PrivateToPublicAccumulatedData, public_call_request::PublicCallRequest,
        tx_constant_data::TxConstantData, validation_requests::RollupValidationRequests,
    },
    address::AztecAddress,
    constants::PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH,
    traits::{Deserialize, Empty, Serialize},
    utils::reader::Reader,
};

pub struct PrivateToPublicKernelCircuitPublicInputs {
    constants: TxConstantData,
    rollup_validation_requests: RollupValidationRequests,
    non_revertible_accumulated_data: PrivateToPublicAccumulatedData,
    revertible_accumulated_data: PrivateToPublicAccumulatedData,
    public_teardown_call_request: PublicCallRequest,
    fee_payer: AztecAddress,
}

impl Empty for PrivateToPublicKernelCircuitPublicInputs {
    fn empty() -> Self {
        PrivateToPublicKernelCircuitPublicInputs {
            constants: TxConstantData::empty(),
            rollup_validation_requests: RollupValidationRequests::empty(),
            non_revertible_accumulated_data: PrivateToPublicAccumulatedData::empty(),
            revertible_accumulated_data: PrivateToPublicAccumulatedData::empty(),
            public_teardown_call_request: PublicCallRequest::empty(),
            fee_payer: AztecAddress::empty(),
        }
    }
}

impl Eq for PrivateToPublicKernelCircuitPublicInputs {
    fn eq(self, other: Self) -> bool {
        (self.constants == other.constants)
            & (self.rollup_validation_requests == other.rollup_validation_requests)
            & (self.non_revertible_accumulated_data == other.non_revertible_accumulated_data)
            & (self.revertible_accumulated_data == other.revertible_accumulated_data)
            & (self.public_teardown_call_request == other.public_teardown_call_request)
            & (self.fee_payer == other.fee_payer)
    }
}

impl Serialize<PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH> for PrivateToPublicKernelCircuitPublicInputs {
    fn serialize(self) -> [Field; PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH] {
        let mut fields: BoundedVec<Field, PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH> =
            BoundedVec::new();

        fields.extend_from_array(self.constants.serialize());
        fields.extend_from_array(self.rollup_validation_requests.serialize());
        fields.extend_from_array(self.non_revertible_accumulated_data.serialize());
        fields.extend_from_array(self.revertible_accumulated_data.serialize());
        fields.extend_from_array(self.public_teardown_call_request.serialize());
        fields.extend_from_array(self.fee_payer.serialize());

        assert_eq(fields.len(), PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH);

        fields.storage()
    }
}

impl Deserialize<PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH> for PrivateToPublicKernelCircuitPublicInputs {
    fn deserialize(
        fields: [Field; PRIVATE_TO_PUBLIC_KERNEL_CIRCUIT_PUBLIC_INPUTS_LENGTH],
    ) -> PrivateToPublicKernelCircuitPublicInputs {
        let mut reader = Reader::new(fields);

        let item = PrivateToPublicKernelCircuitPublicInputs {
            constants: reader.read_struct(TxConstantData::deserialize),
            rollup_validation_requests: reader.read_struct(RollupValidationRequests::deserialize),
            non_revertible_accumulated_data: reader.read_struct(
                PrivateToPublicAccumulatedData::deserialize,
            ),
            revertible_accumulated_data: reader.read_struct(
                PrivateToPublicAccumulatedData::deserialize,
            ),
            public_teardown_call_request: reader.read_struct(PublicCallRequest::deserialize),
            fee_payer: reader.read_struct(AztecAddress::deserialize),
        };
        reader.finish();
        item
    }
}

#[test]
fn serialization_of_empty() {
    let item = PrivateToPublicKernelCircuitPublicInputs::empty();
    let serialized = item.serialize();
    let deserialized = PrivateToPublicKernelCircuitPublicInputs::deserialize(serialized);
    assert(item.eq(deserialized));
}
