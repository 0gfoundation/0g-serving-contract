// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title VerifierInput
/// @notice Structure containing all data required for signature verification
struct VerifierInput {
    string id; // Unique deliverable identifier (MUST be included in signature)
    bytes encryptedSecret;
    bytes modelRootHash;
    uint nonce;
    bytes signature;
    uint taskFee;
    address user;
}

/// @title VerifierLibrary
/// @notice EIP-712 compliant signature verification library for fine-tuning deliverables
/// @dev Uses OpenZeppelin's ECDSA library for secure signature validation with automatic malleability protection
library VerifierLibrary {
    // Custom errors for gas efficiency and better debugging
    error InvalidSignature();
    error DeliverableIdTooLong(uint256 length);

    // EIP-712 Domain Separator constants (following InferenceServing pattern)
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant MESSAGE_TYPEHASH =
        keccak256(
            "VerifierMessage(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,uint256 taskFee,address user)"
        );

    string private constant DOMAIN_NAME = "0G Fine-Tuning Serving";
    string private constant DOMAIN_VERSION = "1";

    uint256 private constant MAX_DELIVERABLE_ID_LENGTH = 256;

    /// @notice Verifies signature using EIP-712 standard
    /// @param input The verifier input containing all signature data
    /// @param expectedAddress The address expected to have signed the message
    /// @param contractAddress The address of the contract (for domain separator)
    /// @return bool True if signature is valid and from expectedAddress
    /// @dev Uses ECDSA.tryRecover for automatic malleability protection (CertiK 0LS-14)
    function verifySignature(
        VerifierInput memory input,
        address expectedAddress,
        address contractAddress
    ) internal view returns (bool) {
        // HIGH-5 FIX: Validate deliverable ID length to prevent DoS
        if (bytes(input.id).length > MAX_DELIVERABLE_ID_LENGTH) {
            revert DeliverableIdTooLong(bytes(input.id).length);
        }

        // Compute EIP-712 domain separator
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                contractAddress
            )
        );

        // Compute EIP-712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                MESSAGE_TYPEHASH,
                keccak256(bytes(input.id)), // CRIT-2 FIX: Include 'id' to prevent signature reuse
                keccak256(input.encryptedSecret),
                keccak256(input.modelRootHash),
                input.nonce,
                input.taskFee,
                input.user
            )
        );

        // Compute EIP-712 typed data hash
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        // ECDSA.tryRecover automatically checks s value malleability and returns error on invalid signature
        (address recovered, ECDSA.RecoverError error) = ECDSA.tryRecover(digest, input.signature);

        // Return true only if recovery succeeded and address matches (CRIT-1 FIX: zero-address check)
        return error == ECDSA.RecoverError.NoError && recovered == expectedAddress;
    }

}
