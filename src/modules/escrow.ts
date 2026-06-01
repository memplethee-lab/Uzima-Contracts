import {
  Address,
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * EscrowModule
 * Handles escrow operations including batch cancellations with admin privileges
 */
export class EscrowModule {
  private server: SorobanRpc.Server;
  private contractId: string;
  private networkPassphrase: string;

  constructor(
    serverUrl: string,
    contractId: string,
    networkPassphrase: string = Networks.TESTNET_NETWORK_PASSPHRASE
  ) {
    this.server = new SorobanRpc.Server(serverUrl);
    this.contractId = contractId;
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Cancel an event and refund all associated escrows
   * 
   * @param adminKeypair - Admin keypair with authorization privileges
   * @param escrowIds - Array of escrow IDs to refund (max 50 per call; handles chunking internally)
   * @returns Promise resolving to transaction hash
   * 
   * @throws Error if not authorized as admin or if transaction fails
   */
  async cancelEvent(adminKeypair: Keypair, escrowIds: bigint[]): Promise<string> {
    // Chunk IDs into groups of 50 to respect contract limits
    const chunks = this.chunkArray(escrowIds, 50);
    let lastTxHash: string = '';

    for (const chunk of chunks) {
      lastTxHash = await this.executeCancelEventChunk(adminKeypair, chunk);
    }

    return lastTxHash;
  }

  /**
   * Execute cancel_event for a single chunk of escrow IDs
   * 
   * @param adminKeypair - Admin keypair with authorization
   * @param escrowIds - Chunk of escrow IDs (max 50)
   * @returns Promise resolving to transaction hash
   */
  private async executeCancelEventChunk(
    adminKeypair: Keypair,
    escrowIds: bigint[]
  ): Promise<string> {
    const account = await this.server.getAccount(adminKeypair.publicKey());
    
    // Convert escrow IDs to ScVal format (Vec of u64)
    const escrowIdsScVal = nativeToScVal(
      Array.from(escrowIds).map(id => Number(id)),
      { type: 'u32' }
    ) as xdr.ScVal;

    // Build transaction with contract invocation
    let tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        SorobanRpc.invokeContractFunction({
          contract: this.contractId,
          method: 'cancel_event',
          args: [escrowIdsScVal],
        })
      )
      .setTimeout(30)
      .build();

    // Sign with admin keypair
    tx.sign(adminKeypair);

    // Send transaction
    const response = await this.server.sendTransaction(tx);

    // Wait for transaction to be confirmed
    if (response.status === 'PENDING' || response.status === 'SUCCESS') {
      let pollCount = 0;
      const maxPolls = 60; // Poll for up to 60 seconds

      while (pollCount < maxPolls) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const txStatus = await this.server.getTransaction(response.hash);
        
        if (
          txStatus.status === 'SUCCESS' ||
          txStatus.status === 'FAILED'
        ) {
          if (txStatus.status === 'FAILED') {
            throw new Error(
              `Transaction failed: ${txStatus.resultXdr || 'Unknown error'}`
            );
          }
          return response.hash;
        }
        
        pollCount++;
      }

      throw new Error('Transaction confirmation timeout');
    } else {
      throw new Error(`Transaction submission failed: ${response.errorResultXdr}`);
    }
  }

  /**
   * Utility function to chunk an array into smaller arrays
   * 
   * @param array - Array to chunk
   * @param size - Size of each chunk
   * @returns Array of chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Get the status of an escrow by ID
   * 
   * @param escrowId - ID of the escrow to query
   * @returns Promise resolving to escrow status
   */
  async getEscrowStatus(escrowId: bigint): Promise<any> {
    const result = await this.server.invokeContractFunction({
      contract: this.contractId,
      method: 'get_escrow',
      args: [nativeToScVal(Number(escrowId), { type: 'u64' })],
    });

    return scValToNative(result);
  }

  /**
   * Get all pending refunds for an escrow event
   * 
   * @param eventId - ID of the event
   * @returns Promise resolving to array of escrow IDs pending refund
   */
  async getPendingRefunds(eventId: bigint): Promise<bigint[]> {
    const result = await this.server.invokeContractFunction({
      contract: this.contractId,
      method: 'get_pending_refunds',
      args: [nativeToScVal(Number(eventId), { type: 'u64' })],
    });

    const refundIds = scValToNative(result) as number[];
    return refundIds.map(id => BigInt(id));
  }
}

export default EscrowModule;
