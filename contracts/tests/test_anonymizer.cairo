use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};

/// Smoke test: the anonymizer declares and deploys with no constructor args.
/// Its real behaviour is exercised against a mock vault; this exists first to
/// prove the toolchain and CI pipeline work end to end.
#[test]
fn anonymizer_deploys() {
    let contract = declare("RhizomeVesuAnonymizer").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();

    let addr_felt: felt252 = address.into();
    assert!(addr_felt != 0, "deployed address must be non-zero");
}
