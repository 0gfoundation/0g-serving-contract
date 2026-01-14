// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

struct Service {
    address provider;
    string url;
    Quota quota;
    uint pricePerToken;
    bool occupied;
    string[] models;
    address teeSignerAddress;
    bool teeSignerAcknowledged;
}

struct Quota {
    uint cpuCount;
    uint nodeMemory;
    uint gpuCount;
    uint nodeStorage;
    string gpuType;
}

library ServiceLibrary {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    error ServiceNotExist(address provider);

    struct ServiceMap {
        EnumerableSet.Bytes32Set _keys;
        mapping(bytes32 => Service) _values;
    }

    function getService(ServiceMap storage map, address provider) internal view returns (Service storage) {
        return _get(map, provider);
    }

    function getAllServices(ServiceMap storage map) internal view returns (Service[] memory services) {
        uint len = _length(map);
        services = new Service[](len);
        for (uint i = 0; i < len; ++i) {
            services[i] = _at(map, i);
        }
    }

    function addOrUpdateService(
        ServiceMap storage map,
        address provider,
        string memory url,
        Quota memory quota,
        uint pricePerToken,
        bool occupied,
        string[] memory models,
        address teeSignerAddress
    ) internal {
        bytes32 key = _key(provider);
        if (!_contains(map, key)) {
            _set(map, key, Service(provider, url, quota, pricePerToken, occupied, models, teeSignerAddress, false));
            return;
        }
        Service storage value = _get(map, provider);

        // Check if critical fields are being changed (fields that require re-acknowledgement)
        bool criticalFieldsChanged = (value.teeSignerAddress != teeSignerAddress);

        value.url = url;
        value.quota = quota;
        value.pricePerToken = pricePerToken;
        value.occupied = occupied;
        value.models = models;
        value.teeSignerAddress = teeSignerAddress;

        // Reset acknowledgement if critical fields changed
        if (criticalFieldsChanged) {
            value.teeSignerAcknowledged = false;
        }
    }

    function removeService(ServiceMap storage map, address provider) internal {
        bytes32 key = _key(provider);
        if (!_contains(map, key)) {
            revert ServiceNotExist(provider);
        }
        _remove(map, key);
    }

    function acknowledgeTEESigner(ServiceMap storage map, address provider) internal {
        Service storage service = _get(map, provider);
        service.teeSignerAcknowledged = true;
    }

    function revokeTEESignerAcknowledgement(ServiceMap storage map, address provider) internal {
        Service storage service = _get(map, provider);
        service.teeSignerAcknowledged = false;
    }

    function serviceExists(ServiceMap storage map, address provider) internal view returns (bool) {
        return _contains(map, _key(provider));
    }

    function _at(ServiceMap storage map, uint index) internal view returns (Service storage) {
        bytes32 key = map._keys.at(index);
        return map._values[key];
    }

    function _set(ServiceMap storage map, bytes32 key, Service memory value) internal returns (bool) {
        map._values[key] = value;
        return map._keys.add(key);
    }

    function _get(ServiceMap storage map, address provider) internal view returns (Service storage) {
        bytes32 key = _key(provider);
        Service storage value = map._values[key];
        if (!_contains(map, key)) {
            revert ServiceNotExist(provider);
        }
        return value;
    }

    function _remove(ServiceMap storage map, bytes32 key) internal returns (bool) {
        delete map._values[key];
        return map._keys.remove(key);
    }

    function _contains(ServiceMap storage map, bytes32 key) internal view returns (bool) {
        return map._keys.contains(key);
    }

    function _length(ServiceMap storage map) internal view returns (uint) {
        return map._keys.length();
    }

    function _key(address provider) internal pure returns (bytes32) {
        return keccak256(abi.encode(provider));
    }
}
