// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.22 <0.9.0;

/**
 * @dev This is a base contract to aid in writing upgradeable contracts that use
 * initialization instead of constructors.
 *
 * STORAGE COMPATIBILITY:
 * - Preserves original `bool public initialized` variable for full backward compatibility
 * - Adds `_initializationLocked` in next slot to track permanent disablement
 * - Safe for upgrading existing deployed contracts
 */
contract Initializable {
    /**
     * @dev Indicates whether the contract has been initialized.
     * IMPORTANT: This variable is preserved exactly as in the original implementation
     * to maintain full storage layout compatibility with deployed contracts.
     */
    bool public initialized;

    /**
     * @dev Indicates whether initialization has been permanently locked (for logic contracts).
     * This is stored in a separate slot to avoid modifying the original `initialized` variable.
     */
    bool private _initializationLocked;

    /**
     * @dev Triggered when the contract has been initialized or reinitialized.
     */
    event Initialized(uint8 version);

    /**
     * @dev A modifier that defines a protected initializer function that can be invoked at most once.
     */
    modifier onlyInitializeOnce() {
        require(!initialized && !_initializationLocked, "Initializable: already initialized");
        initialized = true;
        _;
        emit Initialized(1);
    }

    /**
     * @dev Locks the contract, preventing any future reinitialization. This cannot be part of an initializer call.
     * Calling this in the constructor of a contract will prevent that contract from being initialized or reinitialized
     * to any version. It is recommended to use this to lock implementation contracts that are designed to be called
     * through proxies.
     *
     * Emits an {Initialized} event the first time it is successfully executed.
     */
    function _disableInitializers() internal virtual {
        if (!_initializationLocked) {
            _initializationLocked = true;
            emit Initialized(type(uint8).max);
        }
    }
}
