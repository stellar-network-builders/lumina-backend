#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, IntoVal, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttackState {
    pub vault_contract: Address,
    pub vault_id: Address,
    pub attack_count: u32,
    pub reentrancy_successful: bool,
}

#[contracttype]
pub enum DataKey {
    AttackState,
}

#[contract]
pub struct MaliciousContract;

#[contractimpl]
impl MaliciousContract {
    /// Initialize the malicious contract
    pub fn initialize(env: Env, vault_contract: Address, vault_id: Address) {
        let state = AttackState {
            vault_contract: vault_contract.clone(),
            vault_id: vault_id.clone(),
            attack_count: 0,
            reentrancy_successful: false,
        };
        env.storage().instance().set(&DataKey::AttackState, &state);
    }

    /// Attempt reentrancy attack during claim callback
    /// This function simulates a malicious callback that tries to call claim() again
    pub fn attempt_claim_reentrancy(env: Env) -> bool {
        let mut state = Self::get_attack_state(&env);
        state.attack_count += 1;
        
        // Try to call claim() again while inside the original claim() call
        // This should fail due to reentrancy protection
        let result = env.try_invoke_contract::<i128, soroban_sdk::Error>(
            &state.vault_contract,
            &Symbol::new(&env, "claim"),
            (state.vault_id.clone(),).into_val(&env)
        );

        match result {
            Ok(_) => {
                // If we succeeded, reentrancy protection failed
                state.reentrancy_successful = true;
                env.storage().instance().set(&DataKey::AttackState, &state);
                true
            }
            Err(_) => {
                // Expected behavior - reentrancy was blocked
                env.storage().instance().set(&DataKey::AttackState, &state);
                false
            }
        }
    }

    /// Attempt reentrancy attack by calling revoke() during claim callback
    pub fn attempt_revoke_reentrancy(env: Env) -> bool {
        let mut state = Self::get_attack_state(&env);
        state.attack_count += 1;
        
        // Try to call revoke() while inside the original claim() call
        let result = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &state.vault_contract,
            &Symbol::new(&env, "revoke"),
            (state.vault_id.clone(),).into_val(&env)
        );

        match result {
            Ok(_) => {
                // If we succeeded, reentrancy protection failed
                state.reentrancy_successful = true;
                env.storage().instance().set(&DataKey::AttackState, &state);
                true
            }
            Err(_) => {
                // Expected behavior - reentrancy was blocked
                env.storage().instance().set(&DataKey::AttackState, &state);
                false
            }
        }
    }

    /// Attempt reentrancy attack by calling create_vault() during claim callback
    pub fn attempt_create_vault_reentrancy(env: Env, beneficiary: Address) -> bool {
        let mut state = Self::get_attack_state(&env);
        state.attack_count += 1;
        
        // Try to call create_vault() while inside the original claim() call
        let result = env.try_invoke_contract::<Address, soroban_sdk::Error>(
            &state.vault_contract,
            &Symbol::new(&env, "create_vault"),
            (
                beneficiary,
                1000i128,  // total_amount
                1000u64,   // cliff_date
                1000u64,   // vesting_start
                1000u64,   // vesting_duration
                true,      // revocable
            ).into_val(&env)
        );

        match result {
            Ok(_) => {
                // If we succeeded, reentrancy protection failed
                state.reentrancy_successful = true;
                env.storage().instance().set(&DataKey::AttackState, &state);
                true
            }
            Err(_) => {
                // Expected behavior - reentrancy was blocked
                env.storage().instance().set(&DataKey::AttackState, &state);
                false
            }
        }
    }

    /// Get attack state
    pub fn get_attack_info(env: Env) -> AttackState {
        Self::get_attack_state(&env)
    }

    /// Reset attack state for testing
    pub fn reset_attack_state(env: Env) {
        let state = Self::get_attack_state(&env);
        let reset_state = AttackState {
            vault_contract: state.vault_contract,
            vault_id: state.vault_id,
            attack_count: 0,
            reentrancy_successful: false,
        };
        env.storage().instance().set(&DataKey::AttackState, &reset_state);
    }

    /// Helper function to get attack state
    fn get_attack_state(env: &Env) -> AttackState {
        env.storage().instance()
            .get(&DataKey::AttackState)
            .unwrap_or_else(|| panic!("attack state not initialized"))
    }
}
