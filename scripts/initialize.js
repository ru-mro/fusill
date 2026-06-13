'use strict';
// Calls the initialize instruction on devnet.
// Runs inside the deployer container after anchor deploy.

const { Keypair, Connection, PublicKey, SystemProgram } = require('@solana/web3.js');
const { AnchorProvider, Program, Wallet }               = require('@coral-xyz/anchor');
const { readFileSync }                                   = require('fs');

async function main() {
  const connection   = new Connection('https://api.devnet.solana.com', 'confirmed');
  const deployerBytes = JSON.parse(readFileSync('/wallets/deployer.json', 'utf8'));
  const deployer     = Keypair.fromSecretKey(Uint8Array.from(deployerBytes));

  const idl      = JSON.parse(readFileSync('/shared/fusill-idl.json', 'utf8'));
  const provider  = new AnchorProvider(connection, new Wallet(deployer), { commitment: 'confirmed' });
  const program   = new Program(idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    program.programId
  );

  try {
    await program.methods.initialize()
      .accounts({
        authority:     deployer.publicKey,
        config:        configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([deployer])
      .rpc();
    console.log('Config inicializada:', configPda.toString());
    console.log('Authority (fee recipient):', deployer.publicKey.toString());
  } catch (err) {
    if (err.logs?.some(l => l.includes('already in use'))) {
      console.log('Config ya existe — saltando initialize');
    } else {
      throw err;
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
