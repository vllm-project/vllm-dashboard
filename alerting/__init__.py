"""Runtime core for the vLLM CI alerting service.

Processes scheduled reconciliation commands idempotently against Postgres as
the system of record, and dispatches Slack notifications from a transactional
outbox. See README.md for the seam layout and which tickets extend it.
"""

from alerting.analyzer import (
    AnalyzerError,
    CauseCategory,
    CheckpointRef,
    ComparisonContext,
    CompletedAnalysis,
    FailureCache,
    FailureCondition,
    FailureLifecycle,
    FullCIAnalysisHandler,
    GitHubRestClient,
    PersistedAnalysis,
    PullRequestRef,
    S3CheckpointStore,
    SuspiciousPR,
    pack_checkpoint,
    unpack_checkpoint,
)
from alerting.commands import SCHEMA_VERSION, ScheduledCommand
from alerting.fast_ci import (
    DatabricksFastCISource,
    DatabricksStatementClient,
    FastCIScanHandler,
    FastFailureEvent,
    FastFailureState,
)
from alerting.full_ci import (
    BuildkiteFullCISource,
    BuildkiteRestClient,
    FullCIComparison,
    FullCIJobOutcome,
    FullCIReconciliationHandler,
    FullCIReconciliationState,
    FullCIRun,
)
from alerting.kimi import KimiCodeRunner
from alerting.main_ci import (
    BuildkiteMainCISource,
    MainCIJobAlert,
    MainCIJobObservation,
    MainCIReconciliationHandler,
)
from alerting.ports import (
    ClaimOutcome,
    DestinationMode,
    AutomationExecution,
    AutomationExecutionStatus,
    NotificationIntent,
    NotificationIntentRecord,
    OutboxStatus,
    SlackPermanentError,
    SlackTransientError,
)
from alerting.postgres import (
    PostgresAlertStore,
    build_fast_ci_runtime,
    build_full_ci_analysis_runtime,
    build_full_ci_runtime,
    build_main_ci_runtime,
)
from alerting.runtime import (
    AlertingRuntime,
    DispatchResult,
    HandlerCompletion,
    ProcessResult,
    ProcessStatus,
    UnknownCommandTypeError,
)
from alerting.slack import SlackDeliveryPort, UrllibHttpTransport

__all__ = [
    "SCHEMA_VERSION",
    "AlertingRuntime",
    "AnalyzerError",
    "CauseCategory",
    "CheckpointRef",
    "ClaimOutcome",
    "ScheduledCommand",
    "BuildkiteFullCISource",
    "BuildkiteRestClient",
    "BuildkiteMainCISource",
    "ComparisonContext",
    "CompletedAnalysis",
    "DatabricksFastCISource",
    "DatabricksStatementClient",
    "DestinationMode",
    "DispatchResult",
    "AutomationExecution",
    "AutomationExecutionStatus",
    "FailureCache",
    "FailureCondition",
    "FailureLifecycle",
    "FastCIScanHandler",
    "FastFailureEvent",
    "FastFailureState",
    "FullCIAnalysisHandler",
    "FullCIComparison",
    "FullCIJobOutcome",
    "FullCIReconciliationHandler",
    "FullCIReconciliationState",
    "FullCIRun",
    "MainCIJobAlert",
    "MainCIJobObservation",
    "MainCIReconciliationHandler",
    "GitHubRestClient",
    "HandlerCompletion",
    "KimiCodeRunner",
    "NotificationIntent",
    "NotificationIntentRecord",
    "OutboxStatus",
    "PersistedAnalysis",
    "PostgresAlertStore",
    "ProcessResult",
    "ProcessStatus",
    "PullRequestRef",
    "S3CheckpointStore",
    "SlackPermanentError",
    "SlackDeliveryPort",
    "SlackTransientError",
    "SuspiciousPR",
    "UrllibHttpTransport",
    "UnknownCommandTypeError",
    "build_fast_ci_runtime",
    "build_full_ci_analysis_runtime",
    "build_full_ci_runtime",
    "build_main_ci_runtime",
    "pack_checkpoint",
    "unpack_checkpoint",
]
