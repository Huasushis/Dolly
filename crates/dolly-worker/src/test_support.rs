use std::time::Instant;

use dolly_core_domain::ExtensionId;
use dolly_storage::Database;
use dolly_storage::effect_journal::{
    EffectJournalInsertDisposition, EffectJournalIntentAuthority, insert_intent,
};
use dolly_storage::mcp_readiness::McpTransportReadiness;
use dolly_storage::runtime_binding::{RuntimeBinding, mint_test_runtime_binding};
use dolly_storage::tool_ledger::{LedgerInsertDisposition, insert_authorized};
use dolly_tool_broker::ToolCallLedgerRecord;
use dolly_tool_broker::effect_journal::ExternalEffectJournalRecord;
use dolly_tool_coordinator::{HostMcpStdioInvocation, StdioTransportError};

use super::{
    ProcessGeneration, StartupInitialize, StartupMint, Worker, WorkerError, WorkerStartConfig,
};

fn mint_test(
    database: &mut Database,
    extension_alias: ExtensionId,
) -> Result<RuntimeBinding, WorkerError> {
    mint_test_runtime_binding(database, extension_alias)
        .map_err(|error| WorkerError::Authority(error.to_string()))
}

fn initialize_test(
    invocation: &mut HostMcpStdioInvocation,
    authority: &EffectJournalIntentAuthority,
    database: &Database,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    server_id: &str,
    deadline: Instant,
) -> Result<McpTransportReadiness, StdioTransportError> {
    invocation.initialize_for_test(
        authority,
        database,
        runtime_binding,
        process_generation,
        server_id,
        deadline,
    )
}

impl Worker {
    /// Test-support startup uses only the isolated fixture authority and test
    /// readiness prover. This method is absent from default production builds;
    /// `Worker::start` always uses live Linux authority verification.
    pub fn start_for_test(config: WorkerStartConfig) -> Result<Self, WorkerError> {
        let mint: StartupMint = mint_test;
        let initialize: StartupInitialize = initialize_test;
        Self::start_internal_with(config, mint, initialize, |_| {})
    }
    /// Test-support-only startup seam that observes the real spawned PID
    /// without granting tests any child I/O or ownership capability.
    pub fn start_for_test_with_spawn_observer(
        config: WorkerStartConfig,
        observer: fn(u32),
    ) -> Result<Self, WorkerError> {
        let mint: StartupMint = mint_test;
        let initialize: StartupInitialize = initialize_test;
        Self::start_internal_with(config, mint, initialize, observer)
    }

    /// Test-support-only insertion through the Worker's already-open
    /// authoritative SQLite connection. This avoids a second instance owner;
    /// no authority or proof object crosses the production boundary.
    pub fn insert_authorized_for_test(
        &mut self,
        row: &ToolCallLedgerRecord,
    ) -> Result<(), WorkerError> {
        match insert_authorized(self.database.connection_mut(), row)
            .map_err(|error| WorkerError::Storage(error.to_string()))?
        {
            LedgerInsertDisposition::Inserted { .. } | LedgerInsertDisposition::Replayed { .. } => {
                Ok(())
            }
        }
    }

    /// Test-support-only journal prefill through this Worker's owned
    /// connection, preserving the one-instance lock and production CAS.
    pub fn insert_intent_for_test(
        &mut self,
        record: &ExternalEffectJournalRecord,
    ) -> Result<(), WorkerError> {
        match insert_intent(self.database.connection_mut(), record)
            .map_err(|error| WorkerError::Storage(error.to_string()))?
        {
            EffectJournalInsertDisposition::Inserted { .. }
            | EffectJournalInsertDisposition::Replayed { .. } => Ok(()),
        }
    }

    /// Test-support-only exact Claim intent construction for a restart
    /// fixture. The production minting path remains private and unchanged.
    pub fn intent_record_for_test(
        &self,
        row: &ToolCallLedgerRecord,
        request_bytes: &[u8],
    ) -> Result<ExternalEffectJournalRecord, WorkerError> {
        self.mint_intent_record(row, request_bytes)
    }
}
