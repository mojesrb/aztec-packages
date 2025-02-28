#include "decider_proving_key.hpp"
#include "barretenberg/honk/proof_system/logderivative_library.hpp"
#include "barretenberg/plonk_honk_shared/composer/permutation_lib.hpp"
#include "barretenberg/stdlib_circuit_builders/ultra_circuit_builder.hpp"

namespace bb {

/**
 * @brief Helper method to compute quantities like total number of gates and dyadic circuit size
 *
 * @tparam Flavor
 * @param circuit
 */
template <IsHonkFlavor Flavor> size_t DeciderProvingKey_<Flavor>::compute_dyadic_size(Circuit& circuit)
{
    // for the lookup argument the circuit size must be at least as large as the sum of all tables used
    const size_t min_size_due_to_lookups = circuit.get_tables_size();

    // minimum size of execution trace due to everything else
    size_t min_size_of_execution_trace = circuit.public_inputs.size() + circuit.num_gates;
    if constexpr (IsGoblinFlavor<Flavor>) {
        min_size_of_execution_trace += circuit.blocks.ecc_op.size();
    }

    // The number of gates is the maximum required by the lookup argument or everything else, plus an optional zero row
    // to allow for shifts.
    size_t total_num_gates = num_zero_rows + std::max(min_size_due_to_lookups, min_size_of_execution_trace);

    // Next power of 2 (dyadic circuit size)
    return circuit.get_circuit_subgroup_size(total_num_gates);
}

/**
 * @brief
 * @details
 *
 * @tparam Flavor
 * @param circuit
 */
template <IsHonkFlavor Flavor>
void DeciderProvingKey_<Flavor>::construct_databus_polynomials(Circuit& circuit)
    requires IsGoblinFlavor<Flavor>
{
    auto& calldata_poly = proving_key.polynomials.calldata;
    auto& calldata_read_counts = proving_key.polynomials.calldata_read_counts;
    auto& calldata_read_tags = proving_key.polynomials.calldata_read_tags;
    auto& secondary_calldata_poly = proving_key.polynomials.secondary_calldata;
    auto& secondary_calldata_read_counts = proving_key.polynomials.secondary_calldata_read_counts;
    auto& secondary_calldata_read_tags = proving_key.polynomials.secondary_calldata_read_tags;
    auto& return_data_poly = proving_key.polynomials.return_data;
    auto& return_data_read_counts = proving_key.polynomials.return_data_read_counts;
    auto& return_data_read_tags = proving_key.polynomials.return_data_read_tags;

    auto calldata = circuit.get_calldata();
    auto secondary_calldata = circuit.get_secondary_calldata();
    auto return_data = circuit.get_return_data();

    // Note: We do not utilize a zero row for databus columns
    for (size_t idx = 0; idx < calldata.size(); ++idx) {
        calldata_poly.at(idx) = circuit.get_variable(calldata[idx]);        // calldata values
        calldata_read_counts.at(idx) = calldata.get_read_count(idx);        // read counts
        calldata_read_tags.at(idx) = calldata_read_counts[idx] > 0 ? 1 : 0; // has row been read or not
    }
    for (size_t idx = 0; idx < secondary_calldata.size(); ++idx) {
        secondary_calldata_poly.at(idx) = circuit.get_variable(secondary_calldata[idx]); // secondary_calldata values
        secondary_calldata_read_counts.at(idx) = secondary_calldata.get_read_count(idx); // read counts
        secondary_calldata_read_tags.at(idx) =
            secondary_calldata_read_counts[idx] > 0 ? 1 : 0; // has row been read or not
    }
    for (size_t idx = 0; idx < return_data.size(); ++idx) {
        return_data_poly.at(idx) = circuit.get_variable(return_data[idx]);        // return data values
        return_data_read_counts.at(idx) = return_data.get_read_count(idx);        // read counts
        return_data_read_tags.at(idx) = return_data_read_counts[idx] > 0 ? 1 : 0; // has row been read or not
    }

    auto& databus_id = proving_key.polynomials.databus_id;
    // Compute a simple identity polynomial for use in the databus lookup argument
    for (size_t i = 0; i < databus_id.size(); ++i) {
        databus_id.at(i) = i;
    }
}

template class DeciderProvingKey_<UltraFlavor>;
template class DeciderProvingKey_<UltraKeccakFlavor>;
template class DeciderProvingKey_<MegaFlavor>;
template class DeciderProvingKey_<MegaZKFlavor>;

} // namespace bb
