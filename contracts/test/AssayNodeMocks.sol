// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface IAssayClaim {
    function claim(
        address provider,
        address node,
        uint256 cumulative,
        uint64 epoch,
        bytes calldata signature
    ) external;
}

/// @dev Test-only payout targets for the assay claim adversarial suite.

/// Rejects every transfer — a claim paying this node must revert as a whole.
contract RevertingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

/// On receiving its payout, immediately re-enters claim() with the stored
/// voucher; the reentrant call must find withdrawn already advanced.
contract ReentrantClaimer {
    IAssayClaim public serving;
    address public provider;
    uint256 public cumulative;
    uint64 public epoch;
    bytes public signature;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(
        IAssayClaim _serving,
        address _provider,
        uint256 _cumulative,
        uint64 _epoch,
        bytes calldata _signature
    ) external {
        serving = _serving;
        provider = _provider;
        cumulative = _cumulative;
        epoch = _epoch;
        signature = _signature;
    }

    function doClaim() external {
        serving.claim(provider, address(this), cumulative, epoch, signature);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try serving.claim(provider, address(this), cumulative, epoch, signature) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }
}

/// Burns gas in its receive hook; must only be able to hurt its own claim.
contract GasHeavyReceiver {
    uint256 public sink;

    receive() external payable {
        for (uint256 i = 0; i < 5000; i++) {
            sink = i;
        }
    }
}
