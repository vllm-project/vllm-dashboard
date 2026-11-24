/**
 * The `devices:` form of a vLLM test step, compiled the way the pipeline
 * generator compiles it.
 *
 * This is a port of vllm-project/ci-infra
 * buildkite/pipeline_generator/step_vendors.py, with the device registry from
 * constants.py (NON_AMD_DEVICES) and amd.py (AMD_DEVICE_CONFIGS). Keep the two
 * in step: the generator is the source of truth, and the rules below must not
 * drift from it.
 *
 * A step names its hardware only as the keys of `devices:`. Each key is one
 * job on that device; more jobs on the same device are that device's
 * `variants:`:
 *
 *     - label: V1 Attention
 *       key: v1-attention
 *       devices:
 *         h100:
 *           timeout_in_minutes: 85
 *           commands:
 *             - pytest -v -s v1/attention
 *           variants:
 *             eager:
 *               env:
 *                 VLLM_ENFORCE_EAGER: "1"
 *         b200-k8s:
 *           same_as: h100
 *         mi300_1:
 *           timeout_in_minutes: 125
 *           commands:
 *             - pytest -v -s v1/attention --ignore=v1/attention/test_mla_backends.py
 *       source_file_dependencies:
 *         - vllm/v1/attention/
 *
 * One job is resolved like this (no field is ever shadowed):
 *
 *   - step + device: the device adds `source_file_dependencies` entries and
 *     `env` keys; the other software fields are set at the step level or on
 *     the device, never both;
 *   - `same_as: <sibling>` starts the device from an earlier device of the
 *     same vendor, minus its key, label and variants; written fields replace
 *     the copied ones, except that dependencies add and `env` merges;
 *   - a variant starts from its device's resolved job, minus key and label:
 *     dependencies add, anything else it writes replaces; its `label:`
 *     replaces the title, and ` [<name>]` is always appended;
 *   - the registry adds the image step, the label's icon, tag and
 *     `[Nightly]` (from `optional: true`), the `amd-` key prefix, and for AMD
 *     `dind: false` and the pool's GPU count.
 *
 * Keys, with K the step's `key`: the first non-AMD device is K, any other
 * non-AMD device K-<key_tag>; the first AMD device is amd-K, any other
 * amd-K-<key_tag>; a variant is <its device job's key>-<name>. A `key:` on a
 * device or variant is used verbatim.
 *
 * The compiled output is the older shape every reader here understands: the
 * first non-AMD device job is the step; the AMD job keyed `amd-` + that key is
 * its `mirror.amd`, marked `_exact` (the block is the whole AMD job and
 * inherits nothing from the step); every other job is a step of its own.
 * Steps without `devices:` (the legacy `device` + `mirror` form) are returned
 * as they are.
 *
 * Not ported: E9 (flow-style lists), which needs the yaml's nodes and does not
 * change what a step compiles to, and the generator's "did you mean" hints.
 * Neither are the loader's checks in step.py, which reject a whole pipeline
 * rather than compile a step: the Step model's (`concurrency` with
 * `concurrency_group`, `num_nodes` with `num_devices`), a GitHub status or key
 * that two jobs in any files share, and a job file that is not a map of
 * `steps:`. This port compiles what step_vendors.expand_document compiles; a
 * reader shows what such a file would have run instead of failing.
 */

export type Vendor = "nvidia" | "amd" | "cpu";

export interface DeviceInfo {
  vendor: Vendor;
  /** The label's hardware tag: ":nvidia: (<tag>) <title>". */
  tag: string;
  /** A second device of a vendor in one step is keyed "<key>-<key_tag>". */
  keyTag: string;
  /** The Buildkite queue (constants.AgentQueue). */
  queue: string;
  /** AMD: the GPUs of the pool's agents, which every job gets. */
  gpus?: number;
  /** The image step its jobs depend on, when not their vendor's. */
  image?: string;
}

export const IMAGE_BUILD_STEP = "image-build";
export const CPU_IMAGE_BUILD_STEP = "image-build-cpu";
export const ARM64_IMAGE_BUILD_STEP = "arm64-image-build";
export const AMD_IMAGE_BUILD_STEP = "image-build-amd";

export const VENDOR_ICONS: Readonly<Record<Vendor, string>> = {
  nvidia: ":nvidia:",
  amd: ":amd:",
  cpu: ":computer:",
};
const VENDOR_KEY_PREFIXES: Readonly<Partial<Record<Vendor, string>>> = {
  amd: "amd-",
};

function nonAmd(
  vendor: Vendor,
  tag: string,
  keyTag: string,
  queue: string,
  image?: string,
): DeviceInfo {
  return image ? { vendor, tag, keyTag, queue, image } : { vendor, tag, keyTag, queue };
}

/** constants.NON_AMD_DEVICES */
const NON_AMD_DEVICES: Record<string, DeviceInfo> = {
  h100: nonAmd("nvidia", "H100", "h100", "mithril-h100-pool"),
  h200: nonAmd("nvidia", "H200", "h200", "H200"),
  h200_18gb: nonAmd("nvidia", "H200 MIG 18GB", "h200", "h200_18gb"),
  h200_35gb: nonAmd("nvidia", "H200 MIG 35GB", "h200", "h200_35gb"),
  b200: nonAmd("nvidia", "B200", "b200", "B200"),
  "b200-k8s": nonAmd("nvidia", "B200", "b200", "b200-k8s"),
  a100: nonAmd("nvidia", "A100", "a100", "a100_queue"),
  l4: nonAmd("nvidia", "L4", "l4", "l4-k8s"),
  gh200: nonAmd("nvidia", "GH200", "gh200", "gh200_queue"),
  "dgx-spark": nonAmd(
    "nvidia",
    "DGX Spark",
    "dgx-spark",
    "dgx-spark",
    ARM64_IMAGE_BUILD_STEP,
  ),
  cpu: nonAmd("cpu", "CPU", "cpu", "cpu_queue_premerge_us_east_1"),
  "cpu-small": nonAmd("cpu", "CPU", "cpu", "small_cpu_queue_premerge"),
  "cpu-medium": nonAmd("cpu", "CPU", "cpu", "medium_cpu_queue_premerge"),
};

/** amd._pool: a pool of one GPU family, tagged "MI300", keyed "mi300". */
function pool(queue: string, gpus: number, family: string): DeviceInfo {
  return {
    vendor: "amd",
    tag: family.toUpperCase(),
    keyTag: family,
    queue,
    gpus,
    image: AMD_IMAGE_BUILD_STEP,
  };
}

/** amd._dpx: one partitioned GPU, tagged "MI300 DPX", keyed "mi300-dpx". */
function dpx(queue: string, family: string): DeviceInfo {
  return {
    vendor: "amd",
    tag: `${family.toUpperCase()} DPX`,
    keyTag: `${family}-dpx`,
    queue,
    gpus: 1,
    image: AMD_IMAGE_BUILD_STEP,
  };
}

/** amd.AMD_DEVICES (from AMD_DEVICE_CONFIGS) */
const AMD_DEVICES: Record<string, DeviceInfo> = {
  mi250_1: pool("amd_mi250", 1, "mi250"),
  mi250_2: pool("amd_mi250", 2, "mi250"),
  mi250_4: pool("amd_mi250", 4, "mi250"),
  mi250_8: pool("amd_mi250", 8, "mi250"),
  mi300_1: pool("amd_mi300_1", 1, "mi300"),
  mi300_2: pool("amd_mi300_2", 2, "mi300"),
  mi300_4: pool("amd_mi300_4", 4, "mi300"),
  mi300_8: pool("amd_mi300_8", 8, "mi300"),
  mi300_dpx: dpx("amd_mi300_dpx", "mi300"),
  mi325_1: pool("amd_mi325_1", 1, "mi325"),
  mi325_2: pool("amd_mi325_2", 2, "mi325"),
  mi325_4: pool("amd_mi325_4", 4, "mi325"),
  mi325_8: pool("amd_mi325_8", 8, "mi325"),
  mi355_dpx: dpx("amd_mi355_dpx", "mi355"),
  mi355_1: pool("amd_mi355_1", 1, "mi355"),
  mi355_2: pool("amd_mi355_2", 2, "mi355"),
  mi355_4: pool("amd_mi355_4", 4, "mi355"),
  mi355_8: pool("amd_mi355_8", 8, "mi355"),
};

/** The device registry: every device a `devices:` step may name. */
export const DEVICES: Readonly<Record<string, DeviceInfo>> = {
  ...NON_AMD_DEVICES,
  ...AMD_DEVICES,
};

export function deviceInfo(device: string): DeviceInfo | undefined {
  return Object.hasOwn(DEVICES, device) ? DEVICES[device] : undefined;
}

export const DEVICES_FIELD = "devices";
export const VARIANTS_FIELD = "variants";
export const SAME_AS_FIELD = "same_as";
/** Set on a compiled `mirror.amd`: its fields are the whole AMD job. */
export const EXACT_MIRROR = "_exact";

const STEP_ONLY_FIELDS = [
  "label",
  "key",
  "depends_on",
  "if",
  "autorun_on_main",
  "allow_dependency_failure",
];
const PASSED_THROUGH_FIELDS = ["if", "autorun_on_main", "allow_dependency_failure"];
const SOFTWARE_FIELDS = [
  "automatic_shard",
  "mount_buildkite_agent",
  "no_plugin",
  "working_dir",
  "env",
  "source_file_dependencies",
  "commands",
];
const MACHINE_FIELDS = [
  "optional",
  "soft_fail",
  "num_devices",
  "num_nodes",
  "parallelism",
  "timeout_in_minutes",
  "retry",
  "concurrency",
  "concurrency_group",
  "agent_tags",
  "no_gpu",
  "dind",
];
const DEPENDENCIES_FIELD = "source_file_dependencies";
const ENV_FIELD = "env";
const SET_ONCE_FIELDS = SOFTWARE_FIELDS.filter(
  (name) => name !== DEPENDENCIES_FIELD && name !== ENV_FIELD,
);
const JOB_FIELDS = [
  "key",
  "label",
  "working_dir",
  "depends_on",
  "commands",
  "agent_tags",
  "num_devices",
  "num_nodes",
  "source_file_dependencies",
  "soft_fail",
  "parallelism",
  "concurrency",
  "concurrency_group",
  "timeout_in_minutes",
  "mount_buildkite_agent",
  "env",
  "retry",
  "optional",
  "no_plugin",
  "no_gpu",
  "dind",
  "automatic_shard",
];
/** Fields a `mirror.amd` block is read for. */
const MIRROR_FIELDS = new Set(
  JOB_FIELDS.filter(
    (name) => !["key", "retry", "mount_buildkite_agent"].includes(name),
  ),
);
const AMD_IGNORED_FIELDS = ["retry", "mount_buildkite_agent"];

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const VARIANT_NAME_PATTERN = /^[a-z0-9-]+$/;
/** What the generator puts in front of a title. */
const LABEL_PREFIX = /^\s*(:[a-z0-9_+-]+:|\(|\[Nightly\])/;

const REMOVED_FIELDS: Readonly<Record<string, string>> = {
  device: "a step names its hardware only as keys under `devices:`",
  gpu: "a step names its hardware only as keys under `devices:`",
  mirror: "an AMD job is a device under `devices:`, not a `mirror.amd` block",
  vendors: "the `vendors:` form is gone: list every device under `devices:`",
  target: "another job on the same device is `devices.<device>.variants.<name>`",
  run_on: "another job on the same device is `devices.<device>.variants.<name>`",
  num_gpus: "write `num_devices` on the NVIDIA device",
};

type Fields = Record<string, unknown>;

/** A `devices:` step that does not compile. `code` is the rule (E1-E8). */
export class DeviceStepError extends Error {
  constructor(
    readonly code: string,
    readonly where: string,
    readonly detail: string,
  ) {
    super(`${code} ${where}: ${detail}`);
    this.name = "DeviceStepError";
  }
}

/** One resolved job of a `devices:` step. */
export interface DeviceJob {
  key: string;
  device: string;
  info: DeviceInfo;
  /** The title (no icon, tag or [Nightly]). */
  title: string;
  label: string;
  /** The resolved software and machine fields. */
  fields: Fields;
  /** From the registry and the step; null leaves it to the file's. */
  dependsOn: string[] | null;
  variant: string | null;
  pinned: boolean;
}

function isPlainObject(value: unknown): value is Fields {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function quoted(items: readonly string[]): string {
  return items.map((item) => `\`${item}\``).join(", ");
}

function whereOf(raw: Fields): string {
  return `step ${JSON.stringify(raw.key || raw.label || null)}`;
}

// ---- entry points ------------------------------------------------------------

export function isDeviceStep(raw: unknown): raw is Fields {
  return isPlainObject(raw) && Object.hasOwn(raw, DEVICES_FIELD);
}

/**
 * Reject what only the compiler may write (a `mirror.amd` marked `_exact`)
 * and a leftover `vendors:` step.
 */
export function checkWrittenStep(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  const where = whereOf(raw);
  if (Object.hasOwn(raw, "vendors")) {
    throw new DeviceStepError("E2", where, `\`vendors\`: ${REMOVED_FIELDS.vendors}`);
  }
  const mirror = raw.mirror;
  const amd = isPlainObject(mirror) ? mirror.amd : undefined;
  if (isPlainObject(amd) && Object.hasOwn(amd, EXACT_MIRROR)) {
    throw new DeviceStepError(
      "E2",
      where,
      `\`${EXACT_MIRROR}\` is set when a \`${DEVICES_FIELD}:\` step is compiled`,
    );
  }
}

/**
 * The yaml's steps with every `devices:` step compiled into the step dicts it
 * stands for; other steps as they are. Nothing is modified in place.
 * `groupDependsOn` is the file's `depends_on`.
 *
 * The generator fails the whole pipeline on a step that does not compile. A
 * dashboard must not lose every other step for one, so such a step is passed
 * to `onError` (by default logged) and left out.
 */
export function expandSteps(
  rawSteps: readonly unknown[],
  groupDependsOn?: unknown,
  onError: (error: DeviceStepError, raw: unknown) => void = logStepError,
): unknown[] {
  const expanded: unknown[] = [];
  for (const raw of rawSteps) {
    try {
      if (isDeviceStep(raw)) {
        expanded.push(...compileDeviceStep(raw, groupDependsOn));
      } else {
        checkWrittenStep(raw);
        expanded.push(raw);
      }
    } catch (error) {
      if (!(error instanceof DeviceStepError)) throw error;
      onError(error, raw);
    }
  }
  return expanded;
}

function logStepError(error: DeviceStepError): void {
  console.error(`Skipping a Buildkite step that does not compile: ${error.message}`);
}

/** The step dicts of one `devices:` step, in the step + `mirror.amd` shape. */
export function compileDeviceStep(
  raw: Fields,
  groupDependsOn?: unknown,
): Fields[] {
  const jobs = resolveStep(raw, groupDependsOn);
  const passed: Fields = {};
  for (const name of PASSED_THROUGH_FIELDS) {
    if (Object.hasOwn(raw, name)) passed[name] = raw[name];
  }
  const candidates = jobs.filter(
    (job) => job.info.vendor !== "amd" && job.variant === null,
  );
  const primary =
    candidates.find((job) => job.key === raw.key) ?? candidates[0] ?? null;
  const mirror = primary
    ? (jobs.find(
        (job) => job.info.vendor === "amd" && job.key === `amd-${primary.key}`,
      ) ?? null)
    : null;

  const compiled: Fields[] = [];
  for (const job of jobs) {
    if (job === mirror) continue;
    const step: Fields = { ...clone(passed), ...jobStepFields(job) };
    if (job === primary && mirror) {
      const block: Fields = {};
      for (const [name, value] of Object.entries(jobStepFields(mirror))) {
        if (MIRROR_FIELDS.has(name) || name === "device") block[name] = value;
      }
      block[EXACT_MIRROR] = true;
      step.mirror = { amd: block };
    }
    compiled.push(step);
  }
  return compiled;
}

/** A job as the fields of a step dict. */
export function jobStepFields(job: DeviceJob): Fields {
  const step: Fields = { label: job.label, key: job.key, device: job.device };
  Object.assign(step, clone(job.fields));
  if (job.dependsOn !== null) step.depends_on = [...job.dependsOn];
  if (job.info.vendor === "amd") {
    step.dind = job.fields.dind === true;
    step.num_devices = job.info.gpus;
  }
  return step;
}

// ---- resolving the jobs ------------------------------------------------------

/**
 * Every job of a `devices:` step, in map order (each device, then its
 * variants). Throws DeviceStepError (E1-E8) for a step that breaks a rule.
 */
export function resolveStep(raw: unknown, groupDependsOn?: unknown): DeviceJob[] {
  if (!isPlainObject(raw)) {
    throw new DeviceStepError("E2", "step", "a step must be a map");
  }
  const key = raw.key;
  let where = whereOf(raw);
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new DeviceStepError(
      "E2",
      where,
      "a `devices:` step needs a `key` ([a-zA-Z0-9_-]+)",
    );
  }
  where = `step ${key}`;
  const title = checkedTitle(raw.label, where, true);

  const stepSoftware: Fields = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === DEVICES_FIELD || STEP_ONLY_FIELDS.includes(name)) continue;
    if (SOFTWARE_FIELDS.includes(name)) {
      stepSoftware[name] = checked(name, value, where);
    } else if (MACHINE_FIELDS.includes(name)) {
      throw new DeviceStepError(
        "E4",
        where,
        `\`${name}\` is a machine field, set per device`,
      );
    } else {
      reject(name, where);
    }
  }
  const extraDependsOn = stepDependsOn(raw.depends_on, where);

  const devices = raw[DEVICES_FIELD];
  if (!isPlainObject(devices) || Object.keys(devices).length === 0) {
    throw new DeviceStepError(
      "E2",
      where,
      "`devices` must be a map of device names (e.g. `h100:`)",
    );
  }
  const entries = new Map<string, Fields>();
  for (const [device, entry] of Object.entries(devices)) {
    entries.set(device, deviceEntry(device, entry, `${where}, device ${device}`));
  }

  const keys = deviceKeys(key, entries, where);
  const jobs: DeviceJob[] = [];
  for (const [device, entry] of entries) {
    const info = DEVICES[device];
    const deviceWhere = `${where}, device ${device}`;
    const own = sameAs(device, entry, entries, deviceWhere);
    checkMachine(info, device, own, deviceWhere);
    const fields = mergeIntoStep(stepSoftware, own, deviceWhere);
    const deviceTitle = Object.hasOwn(entry, "label")
      ? checkedTitle(entry.label, deviceWhere)
      : title;
    const dependsOn = jobDependsOn(info, extraDependsOn, groupDependsOn);
    const deviceJob: DeviceJob = {
      key: keys.get(device)!,
      device,
      info,
      title: deviceTitle,
      label: jobLabel(info, deviceTitle, fields),
      fields,
      dependsOn,
      variant: null,
      pinned: Object.hasOwn(entry, "key"),
    };
    jobs.push(deviceJob);
    const variants = (entry[VARIANTS_FIELD] as Record<string, Fields>) ?? {};
    for (const [name, body] of Object.entries(variants)) {
      const variantWhere = `${deviceWhere}, variant ${name}`;
      checkMachine(info, device, body, variantWhere);
      const variantFields = variantFieldsOf(deviceJob.fields, body, variantWhere);
      // `label:` replaces the title only; the ` [<name>]` that tells the
      // variant from its device job stays.
      const variantTitle =
        (Object.hasOwn(body, "label")
          ? checkedTitle(body.label, variantWhere)
          : deviceTitle) + ` [${name}]`;
      jobs.push({
        key: (body.key as string | undefined) || `${deviceJob.key}-${name}`,
        device,
        info,
        title: variantTitle,
        label: jobLabel(info, variantTitle, variantFields),
        fields: variantFields,
        dependsOn,
        variant: name,
        pinned: Object.hasOwn(body, "key"),
      });
    }
  }

  const seen = new Map<string, DeviceJob>();
  for (const job of jobs) {
    const previous = seen.get(job.key);
    if (previous) {
      throw new DeviceStepError(
        "E8",
        where,
        `two jobs are keyed ${job.key} (${jobName(previous)} and ${jobName(job)}); ` +
          "pin a different `key:` on one of them",
      );
    }
    seen.set(job.key, job);
  }
  return jobs;
}

/** `<icon> (<TAG>) [Nightly ]<title>`; a variant's title ends in ` [<name>]`. */
export function jobLabel(info: DeviceInfo, title: string, fields: Fields): string {
  const nightly = fields.optional ? "[Nightly] " : "";
  return `${VENDOR_ICONS[info.vendor]} (${info.tag}) ${nightly}${title}`;
}

/**
 * Each device's job key: `devices` is [device, pinned key or null] in map
 * order. The first non-AMD device is `key`, the first AMD one `amd-<key>`; any
 * other is suffixed with its key_tag.
 */
export function defaultKeys(
  key: string,
  devices: ReadonlyArray<readonly [string, string | null | undefined]>,
): Map<string, string> {
  const keys = new Map<string, string>();
  const first = new Set<boolean>();
  for (const [device, pinned] of devices) {
    const info = DEVICES[device];
    const isAmd = info.vendor === "amd";
    const prefix = VENDOR_KEY_PREFIXES[info.vendor] ?? "";
    const fallback = first.has(isAmd)
      ? `${prefix}${key}-${info.keyTag}`
      : `${prefix}${key}`;
    first.add(isAmd);
    keys.set(device, pinned || fallback);
  }
  return keys;
}

function deviceKeys(
  key: string,
  entries: Map<string, Fields>,
  where: string,
): Map<string, string> {
  const unpinned = new Map<string, string[]>();
  for (const [device, entry] of entries) {
    if (Object.hasOwn(entry, "key")) continue;
    const tag = DEVICES[device].keyTag;
    unpinned.set(tag, [...(unpinned.get(tag) ?? []), device]);
  }
  for (const [tag, devices] of unpinned) {
    if (devices.length > 1) {
      throw new DeviceStepError(
        "E8",
        where,
        `devices ${devices.join(" and ")} share the key tag '${tag}'; ` +
          "pin `key:` on all but one of them",
      );
    }
  }
  return defaultKeys(
    key,
    [...entries].map(([device, entry]) => [device, entry.key as string | undefined]),
  );
}

function jobName(job: DeviceJob): string {
  return job.device + (job.variant ? ` variant ${job.variant}` : "");
}

function deviceEntry(device: string, entry: unknown, where: string): Fields {
  if (!deviceInfo(device)) {
    throw new DeviceStepError(
      "E1",
      where,
      `'${device}' is not in the device registry; expected one of ` +
        Object.keys(DEVICES).sort().join(", "),
    );
  }
  if (entry === null || entry === undefined) return {};
  if (!isPlainObject(entry)) {
    throw new DeviceStepError("E2", where, "a device entry must be a map (or empty)");
  }
  const result: Fields = {};
  for (const [name, value] of Object.entries(entry)) {
    if (name === SAME_AS_FIELD || name === "label") {
      result[name] = value;
    } else if (name === "key") {
      result[name] = pinnedKey(value, where);
    } else if (name === VARIANTS_FIELD) {
      result[name] = variantsOf(value, where);
    } else if (MACHINE_FIELDS.includes(name) || SOFTWARE_FIELDS.includes(name)) {
      result[name] = checked(name, value, where);
    } else if (STEP_ONLY_FIELDS.includes(name)) {
      throw new DeviceStepError("E2", where, `\`${name}\` is set once, at the step level`);
    } else {
      reject(name, where);
    }
  }
  return result;
}

function variantsOf(value: unknown, where: string): Record<string, Fields> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new DeviceStepError(
      "E6",
      where,
      "`variants` must be a map of variant names to changes",
    );
  }
  const variants: Record<string, Fields> = {};
  for (const [name, body] of Object.entries(value)) {
    const variantWhere = `${where}, variant ${name}`;
    if (!VARIANT_NAME_PATTERN.test(name)) {
      throw new DeviceStepError("E1", variantWhere, "a variant name must match [a-z0-9-]+");
    }
    if (body === null || body === undefined || deepEqual(body, {})) {
      throw new DeviceStepError("E6", variantWhere, "a variant must change at least one field");
    }
    if (!isPlainObject(body)) {
      throw new DeviceStepError("E2", variantWhere, "a variant must be a map");
    }
    const result: Fields = {};
    for (const [fieldName, fieldValue] of Object.entries(body)) {
      if (fieldName === SAME_AS_FIELD) {
        throw new DeviceStepError(
          "E5",
          variantWhere,
          "a variant cannot use `same_as`: it already starts from its device's job",
        );
      }
      if (fieldName === "key") {
        result[fieldName] = pinnedKey(fieldValue, variantWhere);
      } else if (fieldName === "label") {
        result[fieldName] = fieldValue;
      } else if (
        MACHINE_FIELDS.includes(fieldName) ||
        SOFTWARE_FIELDS.includes(fieldName)
      ) {
        result[fieldName] = checked(fieldName, fieldValue, variantWhere);
      } else if (fieldName === VARIANTS_FIELD) {
        throw new DeviceStepError("E2", variantWhere, "variants cannot have variants");
      } else if (deviceInfo(fieldName)) {
        throw new DeviceStepError(
          "E2",
          variantWhere,
          `a variant runs on its device; '${fieldName}' goes under \`devices:\``,
        );
      } else if (STEP_ONLY_FIELDS.includes(fieldName)) {
        throw new DeviceStepError(
          "E2",
          variantWhere,
          `\`${fieldName}\` is set once, at the step level`,
        );
      } else {
        reject(fieldName, variantWhere);
      }
    }
    if (!Object.keys(result).some((name) => name !== "key" && name !== "label")) {
      throw new DeviceStepError(
        "E6",
        variantWhere,
        "a variant must change at least one field besides key and label",
      );
    }
    variants[name] = result;
  }
  return variants;
}

/** The device's own fields (no key, label or variants), with `same_as` applied. */
function sameAs(
  device: string,
  entry: Fields,
  entries: Map<string, Fields>,
  where: string,
): Fields {
  const own: Fields = {};
  for (const [name, value] of Object.entries(entry)) {
    if (![SAME_AS_FIELD, "key", "label", VARIANTS_FIELD].includes(name)) {
      own[name] = clone(value);
    }
  }
  const sibling = entry[SAME_AS_FIELD];
  if (sibling === null || sibling === undefined) return own;
  const names = [...entries.keys()];
  if (typeof sibling !== "string" || !entries.has(sibling)) {
    throw new DeviceStepError(
      "E5",
      where,
      `\`same_as: ${String(sibling)}\` must name an earlier device of this step ` +
        "(variants cannot be copied)",
    );
  }
  if (names.indexOf(sibling) >= names.indexOf(device)) {
    throw new DeviceStepError(
      "E5",
      where,
      `\`same_as: ${sibling}\` must name an earlier device`,
    );
  }
  if (DEVICES[sibling].vendor !== DEVICES[device].vendor) {
    throw new DeviceStepError(
      "E5",
      where,
      `\`same_as: ${sibling}\` is a ${DEVICES[sibling].vendor} device; copy only ` +
        "a device of the same vendor",
    );
  }
  const siblingEntry = entries.get(sibling)!;
  if (Object.hasOwn(siblingEntry, SAME_AS_FIELD)) {
    throw new DeviceStepError(
      "E5",
      where,
      `\`same_as: ${sibling}\` points at a device that has \`same_as\` itself; ` +
        `point at ${String(siblingEntry[SAME_AS_FIELD])} instead`,
    );
  }
  const resolved: Fields = {};
  for (const [name, value] of Object.entries(siblingEntry)) {
    if (!["key", "label", VARIANTS_FIELD].includes(name)) {
      resolved[name] = clone(value);
    }
  }
  for (const [name, value] of Object.entries(own)) {
    if (name === DEPENDENCIES_FIELD) {
      const copied = (resolved[name] as string[] | undefined) ?? [];
      const repeated = (value as string[]).filter((dep) => copied.includes(dep));
      if (repeated.length > 0) {
        throw new DeviceStepError(
          "E6",
          where,
          `${quoted(repeated)} already come from ${sibling} (\`same_as\`)`,
        );
      }
      resolved[name] = [...copied, ...(value as string[])];
    } else if (name === ENV_FIELD) {
      const env = { ...((resolved[name] as Record<string, string>) ?? {}) };
      const same = Object.entries(value as Record<string, string>)
        .filter(([variable, val]) => env[variable] === val)
        .map(([variable]) => variable);
      if (same.length > 0) {
        throw new DeviceStepError(
          "E6",
          where,
          `env ${quoted(same)} already come from ${sibling} (\`same_as\`)`,
        );
      }
      Object.assign(env, value);
      resolved[name] = env;
    } else {
      if (Object.hasOwn(resolved, name) && deepEqual(resolved[name], value)) {
        throw new DeviceStepError(
          "E6",
          where,
          `\`${name}\` is the same as ${sibling}'s, which \`same_as\` already copies; drop it`,
        );
      }
      resolved[name] = value;
    }
  }
  return resolved;
}

/**
 * Rule 3a: a device adds dependencies and env vars and sets the other software
 * fields the step does not.
 */
function mergeIntoStep(stepSoftware: Fields, own: Fields, where: string): Fields {
  const fields = clone(stepSoftware);
  for (const [name, value] of Object.entries(own)) {
    if (name === DEPENDENCIES_FIELD) {
      const shared = (stepSoftware[name] as string[] | undefined) ?? [];
      const repeated = (value as string[]).filter((dep) => shared.includes(dep));
      if (repeated.length > 0) {
        throw new DeviceStepError(
          "E3",
          where,
          `${quoted(repeated)} already in the step's \`source_file_dependencies\`; ` +
            "a device only adds entries",
        );
      }
      fields[name] = [...shared, ...(value as string[])];
    } else if (name === ENV_FIELD) {
      const sharedEnv = (stepSoftware[name] as Record<string, string> | undefined) ?? {};
      const redefined = Object.keys(value as Fields).filter((variable) =>
        Object.hasOwn(sharedEnv, variable),
      );
      if (redefined.length > 0) {
        throw new DeviceStepError(
          "E3",
          where,
          `env ${quoted(redefined)} already set at the step level; set it on every ` +
            "device or only at step level",
        );
      }
      fields[name] = { ...sharedEnv, ...(value as Fields) };
    } else if (SET_ONCE_FIELDS.includes(name) && Object.hasOwn(stepSoftware, name)) {
      throw new DeviceStepError(
        "E3",
        where,
        `\`${name}\` is set at the step level and on the device; set it on every ` +
          "device or only at step level",
      );
    } else {
      fields[name] = clone(value);
    }
  }
  return fields;
}

function variantFieldsOf(base: Fields, body: Fields, where: string): Fields {
  const fields = clone(base);
  for (const [name, value] of Object.entries(body)) {
    if (name === "key" || name === "label") continue;
    if (name === DEPENDENCIES_FIELD) {
      const inherited = (fields[name] as string[] | undefined) ?? [];
      const repeated = (value as string[]).filter((dep) => inherited.includes(dep));
      if (repeated.length > 0) {
        throw new DeviceStepError(
          "E6",
          where,
          `${quoted(repeated)} already in the device job's dependencies; a variant ` +
            "only adds entries",
        );
      }
      fields[name] = [...inherited, ...(value as string[])];
    } else if (name === ENV_FIELD) {
      const env = { ...((fields[name] as Record<string, string>) ?? {}) };
      const same = Object.entries(value as Record<string, string>)
        .filter(([variable, val]) => env[variable] === val)
        .map(([variable]) => variable);
      if (same.length > 0) {
        throw new DeviceStepError(
          "E6",
          where,
          `env ${quoted(same)} already have that value in the device job`,
        );
      }
      Object.assign(env, value);
      fields[name] = env;
    } else {
      if (deepEqual(fields[name], value)) {
        throw new DeviceStepError(
          "E6",
          where,
          `\`${name}\` is the device job's already; a variant states only what changes`,
        );
      }
      fields[name] = clone(value);
    }
  }
  return fields;
}

function checkMachine(
  info: DeviceInfo,
  device: string,
  fields: Fields,
  where: string,
): void {
  if (Object.hasOwn(fields, "num_devices") && info.vendor !== "nvidia") {
    throw new DeviceStepError(
      "E7",
      where,
      info.vendor === "amd"
        ? `\`num_devices\` on an AMD device: ${device} already means ${info.gpus} GPU(s) (the pool's); drop it`
        : "`num_devices` is only for NVIDIA devices",
    );
  }
  if (info.vendor === "amd") {
    const ignored = AMD_IGNORED_FIELDS.filter((name) => Object.hasOwn(fields, name));
    if (ignored.length > 0) {
      throw new DeviceStepError("E2", where, `AMD jobs do not read ${quoted(ignored)}; drop it`);
    }
  }
}

/** The registry's image step for the job, then the step's other ones. */
function jobDependsOn(
  info: DeviceInfo,
  extra: string[],
  groupDependsOn: unknown,
): string[] | null {
  if (info.image) return [info.image, ...extra];
  if (info.vendor === "cpu") {
    // A file with `depends_on: []` builds no image for its jobs.
    if (Array.isArray(groupDependsOn) && groupDependsOn.length === 0) {
      return [...extra];
    }
    return [CPU_IMAGE_BUILD_STEP, ...extra];
  }
  // NVIDIA: the file's, which the loader adds when the step has none.
  if (extra.length === 0) return null;
  const group = Array.isArray(groupDependsOn) ? (groupDependsOn as string[]) : [];
  return [...group, ...extra];
}

function stepDependsOn(value: unknown, where: string): string[] {
  if (value === null || value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item)
  ) {
    throw new DeviceStepError("E2", where, "`depends_on` must be a list of step keys");
  }
  const images = (value as string[]).filter(isImageStep);
  if (images.length > 0) {
    throw new DeviceStepError(
      "E2",
      where,
      `${quoted(images)} comes from the device registry; list only other steps in \`depends_on\``,
    );
  }
  return [...(value as string[])];
}

function isImageStep(key: string): boolean {
  if (key.startsWith("image-build")) return true;
  return Object.values(DEVICES).some((info) => info.image === key);
}

function checkedTitle(value: unknown, where: string, required = false): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DeviceStepError(
      "E2",
      where,
      "`label` must be a title" + (required ? " (it is required)" : ""),
    );
  }
  if (LABEL_PREFIX.test(value)) {
    throw new DeviceStepError(
      "E2",
      where,
      `label '${value}': write the bare title; the generator adds the icon, tag and [Nightly]`,
    );
  }
  return value;
}

function pinnedKey(value: unknown, where: string): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new DeviceStepError("E2", where, "`key` must match [a-zA-Z0-9_-]+");
  }
  return value;
}

const BOOL_FIELDS = [
  "automatic_shard",
  "mount_buildkite_agent",
  "no_plugin",
  "optional",
  "soft_fail",
  "no_gpu",
];
const INT_FIELDS = [
  "num_devices",
  "num_nodes",
  "parallelism",
  "timeout_in_minutes",
  "concurrency",
];

/** The value of a software or machine field, checked for its type. */
function checked(name: string, value: unknown, where: string): unknown {
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  ) {
    throw new DeviceStepError(
      "E6",
      where,
      `\`${name}\` is empty: write a value or drop the field`,
    );
  }
  if (name === DEPENDENCIES_FIELD || name === "commands") {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string" && item)
    ) {
      throw new DeviceStepError("E2", where, `\`${name}\` must be a list of strings`);
    }
  } else if (name === ENV_FIELD) {
    if (
      !isPlainObject(value) ||
      !Object.values(value).every((val) => typeof val === "string")
    ) {
      throw new DeviceStepError("E2", where, "`env` must map names to strings (quote numbers)");
    }
  } else if (BOOL_FIELDS.includes(name)) {
    if (typeof value !== "boolean") {
      throw new DeviceStepError("E2", where, `\`${name}\` must be true or false`);
    }
  } else if (INT_FIELDS.includes(name)) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new DeviceStepError("E2", where, `\`${name}\` must be a number`);
    }
  } else if (name === "dind") {
    if (value !== true) {
      throw new DeviceStepError(
        "E2",
        where,
        "only `dind: true` may be written: AMD jobs run without dind, the others with it",
      );
    }
  } else if (name === "working_dir" || name === "concurrency_group") {
    if (typeof value !== "string") {
      throw new DeviceStepError("E2", where, `\`${name}\` must be a string`);
    }
  } else if (name === "agent_tags" || name === "retry") {
    if (!isPlainObject(value)) {
      throw new DeviceStepError("E2", where, `\`${name}\` must be a map`);
    }
  }
  return clone(value);
}

function reject(name: string, where: string): never {
  if (Object.hasOwn(REMOVED_FIELDS, name)) {
    throw new DeviceStepError("E2", where, `\`${name}\`: ${REMOVED_FIELDS[name]}`);
  }
  throw new DeviceStepError("E2", where, `unknown field \`${name}\``);
}
