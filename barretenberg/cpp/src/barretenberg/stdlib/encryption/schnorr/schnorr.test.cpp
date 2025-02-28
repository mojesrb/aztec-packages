#include <gtest/gtest.h>

#include "barretenberg/circuit_checker/circuit_checker.hpp"
#include "barretenberg/crypto/pedersen_commitment/pedersen.hpp"
#include "barretenberg/ecc/curves/grumpkin/grumpkin.hpp"
#include "barretenberg/stdlib_circuit_builders/ultra_circuit_builder.hpp"
#include "schnorr.hpp"

using namespace bb;
using namespace bb::stdlib;
using namespace bb::crypto;

using Builder = UltraCircuitBuilder;
using bool_ct = bool_t<Builder>;
using byte_array_ct = byte_array<Builder>;
using field_ct = field_t<Builder>;
using witness_ct = witness_t<Builder>;

/**
 * @test Test circuit verifying a Schnorr signature generated by \see{crypto::schnorr_verify_signature}.
 * We only test: messages signed and verified using Grumpkin and the BLAKE2s hash function. We test strings of lengths
 * 0, 1, ..., 33.
 */
TEST(stdlib_schnorr, schnorr_verify_signature)
{
    std::string longer_string = "This is a test string of length 34";

    std::vector<size_t> test_lengths({ 0, 1, 32, 33 });
    for (size_t i : test_lengths) {
        Builder builder = Builder();
        auto message_string = longer_string.substr(0, i);

        schnorr_key_pair<grumpkin::fr, grumpkin::g1> account;
        account.private_key = grumpkin::fr::random_element();
        account.public_key = grumpkin::g1::one * account.private_key;

        schnorr_signature signature =
            schnorr_construct_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(message_string,
                                                                                                 account);

        bool first_result = schnorr_verify_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(
            message_string, account.public_key, signature);
        EXPECT_EQ(first_result, true);

        cycle_group<Builder> pub_key{ witness_ct(&builder, account.public_key.x),
                                      witness_ct(&builder, account.public_key.y),
                                      false };
        schnorr_signature_bits sig = schnorr_convert_signature(&builder, signature);
        byte_array_ct message(&builder, message_string);
        schnorr_verify_signature(message, pub_key, sig);

        info("num gates = ", builder.get_estimated_num_finalized_gates());
        bool result = CircuitChecker::check(builder);
        EXPECT_EQ(result, true);
    }
}

/**
 * @brief Verification fails when the wrong public key is used.
 *
 */
TEST(stdlib_schnorr, verify_signature_failure)
{
    Builder builder = Builder();
    std::string message_string = "This is a test string of length 34";

    // create key pair 1
    schnorr_key_pair<grumpkin::fr, grumpkin::g1> account1;
    account1.private_key = grumpkin::fr::random_element();
    account1.public_key = grumpkin::g1::one * account1.private_key;

    // create key pair 2
    schnorr_key_pair<grumpkin::fr, grumpkin::g1> account2;
    account2.private_key = grumpkin::fr::random_element();
    account2.public_key = grumpkin::g1::one * account2.private_key;

    // sign the message with account 1 private key
    schnorr_signature signature =
        schnorr_construct_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(message_string, account1);

    // check native verification with account 2 public key fails
    bool native_result = schnorr_verify_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(
        message_string, account2.public_key, signature);
    EXPECT_EQ(native_result, false);

    // check stdlib verification with account 2 public key fails
    cycle_group<Builder> pub_key2_ct{ witness_ct(&builder, account2.public_key.x),
                                      witness_ct(&builder, account2.public_key.y),
                                      false };
    schnorr_signature_bits sig = schnorr_convert_signature(&builder, signature);
    byte_array_ct message(&builder, message_string);
    schnorr_verify_signature(message, pub_key2_ct, sig);

    info("num gates = ", builder.get_estimated_num_finalized_gates());

    bool verification_result = CircuitChecker::check(builder);
    EXPECT_EQ(verification_result, false);
}

/**
 * @test Like stdlib_schnorr.schnorr_verify_signature, but we use the function signature_verification that produces a
 * boolean witness and does not require the prover to provide a valid signature.
 */
TEST(stdlib_schnorr, schnorr_signature_verification_result)
{
    std::string longer_string = "This is a test string of length 34";

    Builder builder = Builder();

    schnorr_key_pair<grumpkin::fr, grumpkin::g1> account;
    account.private_key = grumpkin::fr::random_element();
    account.public_key = grumpkin::g1::one * account.private_key;

    schnorr_signature signature =
        schnorr_construct_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(longer_string, account);

    bool first_result = schnorr_verify_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(
        longer_string, account.public_key, signature);
    EXPECT_EQ(first_result, true);

    cycle_group<Builder> pub_key{ witness_ct(&builder, account.public_key.x),
                                  witness_ct(&builder, account.public_key.y),
                                  false };
    schnorr_signature_bits sig = schnorr_convert_signature(&builder, signature);
    byte_array_ct message(&builder, longer_string);
    bool_ct signature_result = schnorr_signature_verification_result(message, pub_key, sig);
    EXPECT_EQ(signature_result.witness_bool, true);

    info("num gates = ", builder.get_estimated_num_finalized_gates());

    bool result = CircuitChecker::check(builder);
    EXPECT_EQ(result, true);
}

/**
 * @test Like stdlib_schnorr.verify_signature_failure, but we use the function signature_verification that produces a
 * boolean witness and allow for proving that a signature verification fails.
 */
TEST(stdlib_schnorr, signature_verification_result_failure)
{
    Builder builder = Builder();
    std::string message_string = "This is a test string of length 34";

    // create key pair 1
    schnorr_key_pair<grumpkin::fr, grumpkin::g1> account1;
    account1.private_key = grumpkin::fr::random_element();
    account1.public_key = grumpkin::g1::one * account1.private_key;

    // create key pair 2
    schnorr_key_pair<grumpkin::fr, grumpkin::g1> account2;
    account2.private_key = grumpkin::fr::random_element();
    account2.public_key = grumpkin::g1::one * account2.private_key;

    // sign the message with account 1 private key
    schnorr_signature signature =
        schnorr_construct_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(message_string, account1);

    // check native verification with account 2 public key fails
    bool native_result = schnorr_verify_signature<Blake2sHasher, grumpkin::fq, grumpkin::fr, grumpkin::g1>(
        message_string, account2.public_key, signature);
    EXPECT_EQ(native_result, false);

    // check stdlib verification with account 2 public key fails
    cycle_group<Builder> pub_key2_ct{ witness_ct(&builder, account2.public_key.x),
                                      witness_ct(&builder, account2.public_key.y),
                                      false };
    schnorr_signature_bits sig = schnorr_convert_signature(&builder, signature);
    byte_array_ct message(&builder, message_string);
    bool_ct signature_result = schnorr_signature_verification_result(message, pub_key2_ct, sig);
    EXPECT_EQ(signature_result.witness_bool, false);

    info("num gates = ", builder.get_estimated_num_finalized_gates());

    bool verification_result = CircuitChecker::check(builder);
    EXPECT_EQ(verification_result, true);
}
