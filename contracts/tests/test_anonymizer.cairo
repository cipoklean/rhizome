use rhizome_anonymizer::mocks::{
    IMockERC20Dispatcher, IMockERC20DispatcherTrait, IMockVaultDispatcher, IMockVaultDispatcherTrait,
};
use rhizome_anonymizer::{
    IRhizomeVesuAnonymizerDispatcher, IRhizomeVesuAnonymizerDispatcherTrait, LendingOperation,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;

const ASSETS: u256 = 1000;
const NOTE_ID: felt252 = 'note-0';

fn pool() -> ContractAddress {
    'POOL'.try_into().unwrap()
}

/// Deploys underlying token, vault and anonymizer.
fn setup(mints_shares: bool) -> (IMockERC20Dispatcher, IMockVaultDispatcher, ContractAddress) {
    let erc20_class = declare("MockERC20").unwrap().contract_class();
    let (underlying_addr, _) = erc20_class.deploy(@array![]).unwrap();

    let vault_class = declare("MockVesuVault").unwrap().contract_class();
    let mut vault_args = array![];
    underlying_addr.serialize(ref vault_args);
    mints_shares.serialize(ref vault_args);
    let (vault_addr, _) = vault_class.deploy(@vault_args).unwrap();

    let anon_class = declare("RhizomeVesuAnonymizer").unwrap().contract_class();
    let (anon_addr, _) = anon_class.deploy(@array![]).unwrap();

    (
        IMockERC20Dispatcher { contract_address: underlying_addr },
        IMockVaultDispatcher { contract_address: vault_addr },
        anon_addr,
    )
}

#[test]
fn anonymizer_deploys() {
    let (_, _, anon_addr) = setup(true);
    let addr_felt: felt252 = anon_addr.into();
    assert!(addr_felt != 0, "deployed address must be non-zero");
}

#[test]
fn vault_exposes_wallet_compatible_token_metadata() {
    let (underlying, vault, _) = setup(true);

    assert!(vault.name() == "Rhizome Vesu STRK", "vault name must be standard ERC20 metadata");
    assert!(vault.symbol() == "rvSTRK", "vault symbol must fit Wallet API token constraints");
    assert!(vault.decimals() == 18, "vault shares must use STRK precision");
    assert!(vault.asset() == underlying.contract_address, "vault asset must be the underlying");
    assert!(vault.convert_to_assets(ASSETS) == ASSETS, "mock vault must remain one-to-one");
}

#[test]
fn deposit_credits_open_note_with_shares() {
    let (underlying, vault, anon_addr) = setup(true);

    // The pool has already withdrawn the underlying to the helper.
    underlying.mint(anon_addr, ASSETS);

    let anon = IRhizomeVesuAnonymizerDispatcher { contract_address: anon_addr };
    start_cheat_caller_address(anon_addr, pool());
    let deposits = anon
        .privacy_invoke(
            LendingOperation::Deposit,
            underlying.contract_address,
            vault.contract_address,
            ASSETS,
            NOTE_ID,
        );
    stop_cheat_caller_address(anon_addr);

    assert!(deposits.len() == 1, "expected exactly one open-note deposit");
    let d = *deposits.at(0);
    assert!(d.note_id == NOTE_ID, "note id must pass through unchanged");
    assert!(d.token == vault.contract_address, "credited token must be the vault");
    assert!(d.amount == 1000_u128, "credited amount must equal minted shares");

    // Shares are held by the helper, and the pool is approved to pull them.
    assert!(vault.balance_of(anon_addr) == ASSETS, "helper should hold the shares");
    assert!(vault.allowance(anon_addr, pool()) == ASSETS, "pool must be approved for the output");
    // The underlying moved into the vault.
    assert!(underlying.balance_of(vault.contract_address) == ASSETS, "vault should hold underlying");
}

#[test]
fn withdraw_credits_open_note_with_underlying() {
    let (underlying, vault, anon_addr) = setup(true);

    // Helper holds vault shares; the vault holds the matching underlying.
    vault.mint_shares(anon_addr, ASSETS);
    underlying.mint(vault.contract_address, ASSETS);

    let anon = IRhizomeVesuAnonymizerDispatcher { contract_address: anon_addr };
    start_cheat_caller_address(anon_addr, pool());
    let deposits = anon
        .privacy_invoke(
            LendingOperation::Withdraw,
            vault.contract_address,
            underlying.contract_address,
            ASSETS,
            NOTE_ID,
        );
    stop_cheat_caller_address(anon_addr);

    assert!(deposits.len() == 1, "expected exactly one open-note deposit");
    let d = *deposits.at(0);
    assert!(d.token == underlying.contract_address, "credited token must be the underlying");
    assert!(d.amount == 1000_u128, "credited amount must equal assets withdrawn");

    assert!(underlying.balance_of(anon_addr) == ASSETS, "helper should hold the underlying");
    assert!(
        underlying.allowance(anon_addr, pool()) == ASSETS, "pool must be approved for the output",
    );
    assert!(vault.balance_of(anon_addr) == 0, "shares should be burned");
}

#[test]
#[should_panic(expected: 'ZERO_OUT_AMOUNT')]
fn deposit_that_yields_nothing_reverts() {
    // A vault that takes the underlying and mints no shares must not credit
    // an empty note — the whole pool transaction should roll back instead.
    let (underlying, vault, anon_addr) = setup(false);
    underlying.mint(anon_addr, ASSETS);

    let anon = IRhizomeVesuAnonymizerDispatcher { contract_address: anon_addr };
    start_cheat_caller_address(anon_addr, pool());
    anon
        .privacy_invoke(
            LendingOperation::Deposit,
            underlying.contract_address,
            vault.contract_address,
            ASSETS,
            NOTE_ID,
        );
}

#[test]
#[should_panic(expected: 'TOKENS_EQUAL')]
fn rejects_identical_tokens() {
    let (underlying, _, anon_addr) = setup(true);
    let anon = IRhizomeVesuAnonymizerDispatcher { contract_address: anon_addr };
    start_cheat_caller_address(anon_addr, pool());
    anon
        .privacy_invoke(
            LendingOperation::Deposit,
            underlying.contract_address,
            underlying.contract_address,
            ASSETS,
            NOTE_ID,
        );
}

#[test]
#[should_panic(expected: 'ZERO_ASSETS')]
fn rejects_zero_assets() {
    let (underlying, vault, anon_addr) = setup(true);
    let anon = IRhizomeVesuAnonymizerDispatcher { contract_address: anon_addr };
    start_cheat_caller_address(anon_addr, pool());
    anon
        .privacy_invoke(
            LendingOperation::Deposit,
            underlying.contract_address,
            vault.contract_address,
            0,
            NOTE_ID,
        );
}

#[test]
#[should_panic(expected: 'INSUFFICIENT_BALANCE')]
fn rejects_when_pool_sent_nothing() {
    // Guards against being called without the pool's withdraw leg.
    let (underlying, vault, anon_addr) = setup(true);
    let anon = IRhizomeVesuAnonymizerDispatcher { contract_address: anon_addr };
    start_cheat_caller_address(anon_addr, pool());
    anon
        .privacy_invoke(
            LendingOperation::Deposit,
            underlying.contract_address,
            vault.contract_address,
            ASSETS,
            NOTE_ID,
        );
}
