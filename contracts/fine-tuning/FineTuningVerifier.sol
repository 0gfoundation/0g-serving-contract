// SPDX-License-Identifier: MIT
pragma solidity >=0.8.22 <0.9.0;

struct VerifierInput {
    string id; // Changed from bytes32 to string
    bytes encryptedSecret;
    bytes modelRootHash;
    uint nonce;
    address providerSigner;
    bytes signature;
    uint taskFee;
    address user;
}

library VerifierLibrary {
    function verifySignature(VerifierInput memory input, address expectedAddress) internal pure returns (bool) {
        bytes32 messageHash = getMessageHash(input);
        bytes32 ethSignedMessageHash = getEthSignedMessageHash(messageHash);
        return recoverSigner(ethSignedMessageHash, input.signature) == expectedAddress;
    }

    function getMessageHash(VerifierInput memory input) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    input.encryptedSecret,
                    input.modelRootHash,
                    input.nonce,
                    input.providerSigner,
                    input.taskFee,
                    input.user
                )
            );
    }

    function splitSignature(bytes memory sig) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        require(sig.length == 65);

        assembly {
            // first 32 bytes, after the length prefix.
            r := mload(add(sig, 32))
            // second 32 bytes.
            s := mload(add(sig, 64))
            // final byte (first byte of the next 32 bytes).
            v := byte(0, mload(add(sig, 96)))
        }

        return (v, r, s);
    }

    function recoverSigner(bytes32 message, bytes memory sig) internal pure returns (address) {
        (uint8 v, bytes32 r, bytes32 s) = splitSignature(sig);
        return ecrecover(message, v, r, s);
    }

    function getEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }
}
