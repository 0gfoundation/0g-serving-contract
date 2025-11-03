#!/bin/bash

while true; do
    sh_count=$(pgrep -x "sh" -c)
    echo "Number of sh processes: $sh_count"
    
    if [ "$sh_count" -gt 1 ]; then
        if [ ! -f "/usr/src/app/deployed.txt" ]; then
            cd /usr/src/app || exit
            
            echo "=========================================="
            echo "Starting deployment process..."
            echo "=========================================="
            
            # Step 1: Deploy LedgerManager
            echo "Step 1: Deploying LedgerManager..."
            
            # Clean deployment directory to avoid cache issues
            if [ -d "deployments/localhost" ]; then
                echo "Cleaning previous deployment cache..."
                rm -rf deployments/localhost
            fi
            
            # Compile contracts first to ensure typechain is generated
            echo "Compiling contracts..."
            npx hardhat compile --force
            if [ $? -ne 0 ]; then
                echo "Compilation failed, retrying..." >&2
                sleep 5
                continue
            fi
            
            npx hardhat deploy --tags ledger --network localhost
            if [ $? -ne 0 ]; then
                echo "LedgerManager deployment failed, retrying..." >&2
                sleep 5
                continue
            fi
            echo "✅ LedgerManager deployed successfully"
            
            # Step 2: Deploy Inference Service v1.0
            echo "Step 2: Deploying InferenceServing v1.0..."
            export SERVICE_TYPE=inference
            export SERVICE_VERSION=v1.0
            export SET_RECOMMENDED=true
            npx hardhat deploy --tags deploy-service --network localhost
            if [ $? -ne 0 ]; then
                echo "InferenceServing v1.0 deployment failed, retrying..." >&2
                sleep 5
                continue
            fi
            echo "✅ InferenceServing v1.0 deployed and registered"
            
            # Step 3: Deploy Fine-Tuning Service v1.0
            echo "Step 3: Deploying FineTuningServing v1.0..."
            export SERVICE_TYPE=fine-tuning
            export SERVICE_VERSION=v1.0
            export SET_RECOMMENDED=true
            npx hardhat deploy --tags deploy-service --network localhost
            if [ $? -ne 0 ]; then
                echo "FineTuningServing v1.0 deployment failed, retrying..." >&2
                sleep 5
                continue
            fi
            echo "✅ FineTuningServing v1.0 deployed and registered"
            
            # Optional: Deploy additional versions for testing
            if [ "${DEPLOY_MULTIPLE_VERSIONS}" = "true" ]; then
                echo "Deploying additional versions for testing..."
                
                # Deploy Inference v2.0
                export SERVICE_TYPE=inference
                export SERVICE_VERSION=v2.0
                export SET_RECOMMENDED=false
                npx hardhat deploy --tags deploy-service --network localhost
                echo "✅ InferenceServing v2.0 deployed"
                
                # Deploy Fine-Tuning v2.0
                export SERVICE_TYPE=fine-tuning
                export SERVICE_VERSION=v2.0
                export SET_RECOMMENDED=false
                npx hardhat deploy --tags deploy-service --network localhost
                echo "✅ FineTuningServing v2.0 deployed"
            fi
            
            echo "=========================================="
            echo "All contracts deployed successfully!"
            echo "=========================================="
            
            # Mark deployment as complete
            touch "deployed.txt"
            
            # Output deployment information
            echo "Deployment Summary:"
            echo "- LedgerManager: Deployed"
            echo "- InferenceServing v1.0: Deployed (Recommended)"
            echo "- FineTuningServing v1.0: Deployed (Recommended)"
            
            if [ "${DEPLOY_MULTIPLE_VERSIONS}" = "true" ]; then
                echo "- InferenceServing v2.0: Deployed"
                echo "- FineTuningServing v2.0: Deployed"
            fi
            
            exit 0
        else
            echo "deployed.txt already exists"
            exit 0
        fi
    else
        echo "sh process count is not greater than 1"
    fi
    
    echo "waiting..."
    sleep 15
done