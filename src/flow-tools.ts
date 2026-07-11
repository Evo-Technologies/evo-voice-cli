import crypto from "node:crypto";

const RESOURCE_TYPES = new Set([
  "AudioFile",
  "PhoneNumber",
  "Assistant",
  "User",
  "Endpoint",
  "File",
  "FaxNumber",
  "EmailAccount",
  "Customer",
  "Flow",
  "Team",
  "SipTrunk",
]);

const ENDPOINT_RESOURCE_TYPES = new Set([
  "PhoneNumber",
  "Assistant",
  "User",
  "Endpoint",
  "FaxNumber",
  "Team",
  "SipTrunk",
]);

const SENSITIVE_NAME = /(api.?key|auth|password|secret|token|credential)/i;

type JsonObject = Record<string, unknown>;
export type JsonPath = Array<string | number>;

export interface FlowIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface PortableReference {
  type: string;
  sourceId: string;
  label?: string;
  path: JsonPath;
  location: string;
  encoding: "value" | "flow-url";
  internal?: boolean;
}

export interface PortableFlowPackage {
  kind: "evov-portable-flow-package";
  version: 1;
  exportedAt: string;
  source: {
    accountId?: string;
    accountName?: string;
    env?: string;
  };
  package: {
    flows: JsonObject[];
    customerFields: unknown[];
    endpointFields: unknown[];
    systemFields: unknown[];
  };
  references: PortableReference[];
  warnings: string[];
}

export interface ResourceCandidate {
  id: string;
  type: string;
  labels: string[];
  metadata?: JsonObject;
}

export interface ReferenceResolution {
  reference: PortableReference;
  status: "internal" | "mapped" | "resolved" | "unresolved" | "ambiguous";
  destinationId?: string;
  candidates?: Array<{ id: string; type: string; label?: string }>;
}

export type FlowEditOperation =
  | { op: "set"; node: string; parameter: string; value: unknown; source?: string }
  | { op: "connect"; node: string; transition: string; target: string }
  | { op: "disconnect"; node: string; transition: string }
  | { op: "add-node"; node: JsonObject }
  | { op: "remove-node"; node: string; disconnectIncoming?: boolean };

export interface FlowEditResult {
  flow: JsonObject;
  patch: { nodes: unknown[] };
  operations: Array<Record<string, unknown>>;
  validation: ReturnType<typeof validateFlowStructure>;
  diff: ReturnType<typeof diffFlowLogic>;
}

export function buildFlowLogic(flowValue: unknown, includeDefaults = false): JsonObject {
  const flow = asObject(flowValue);
  const nodes = asArray(flow.nodes).map(asObject);
  const exits = asArray(flow.exits).map(asObject);
  const nodeById = new Map(nodes.map((node) => [asString(node.id), node]));
  const exitNames = new Set(exits.map((exit) => asString(exit.name)).filter(Boolean));
  const startNodes = nodes.filter((node) => node.isStartNode === true);
  const edges: Array<{ from: string; on: string; target: string; kind: "node" | "exit" | "missing" }> = [];

  const logicNodes = nodes.map((node) => {
    const id = asString(node.id);
    const spec = asObject(node.spec);
    const parameters = asObject(node.parameters);
    const inputs: JsonObject = {};
    const transitions: unknown[] = [];
    const outputs: JsonObject = {};

    for (const [name, raw] of Object.entries(parameters)) {
      const parameter = asObject(raw);
      const type = asString(parameter.type);
      if (type === "Transition") {
        const target = valueString(parameter.value);
        if (!target) {
          if (includeDefaults) transitions.push({ on: name, target: null });
          continue;
        }
        const targetNode = nodeById.get(target);
        const kind = targetNode ? "node" : exitNames.has(target) ? "exit" : "missing";
        edges.push({ from: id, on: name, target, kind });
        transitions.push({
          on: name,
          target,
          targetLabel: targetNode ? nodeLabel(targetNode) : target,
          kind,
          async: parameter.isAsync === true || undefined,
        });
        continue;
      }

      const compact = compactParameter(name, parameter, includeDefaults);
      if (compact === undefined) continue;
      if (parameter.isOutput === true) outputs[name] = compact;
      else inputs[name] = compact;
    }

    const subflowId = flowIdFromUrl(asString(spec.url));
    return {
      id,
      label: nodeLabel(node),
      type: asString(spec.typeName) || asString(spec.name),
      action: asString(spec.name) || asString(spec.typeName),
      start: node.isStartNode === true || undefined,
      ...(subflowId ? { subflow: { id: subflowId, name: asString(spec.name) || undefined } } : {}),
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      transitions,
    };
  });

  const reachable = reachableNodeIds(startNodes.map((node) => asString(node.id)), edges);
  const unreachable = nodes.map((node) => asString(node.id)).filter((id) => id && !reachable.has(id));
  const missingTargets = edges.filter((edge) => edge.kind === "missing");
  const references = findPortableReferences(flow).map((ref) => ({
    type: ref.type,
    id: ref.sourceId,
    label: ref.label,
    location: ref.location,
    internal: ref.internal || undefined,
  }));

  const warnings: string[] = [];
  if (startNodes.length !== 1 && nodes.length > 0) warnings.push(`Expected one start node; found ${startNodes.length}.`);
  if (unreachable.length > 0) warnings.push(`${unreachable.length} node(s) are unreachable from the start node.`);
  if (missingTargets.length > 0) warnings.push(`${missingTargets.length} transition(s) target missing nodes/exits.`);

  return {
    format: "evov-flow-logic",
    version: 1,
    flow: {
      id: asString(flow.id) || undefined,
      name: asString(flow.name) || undefined,
      description: asString(flow.description) || undefined,
      notes: asString(flow.notes) || undefined,
      customer: asString(flow.customerName) || asString(flow.customerId) || undefined,
      roles: asArray(flow.roles),
      entry: startNodes.length === 1 ? asString(startNodes[0].id) : null,
      parameters: asArray(flow.parameters).map(compactFlowParameter),
      exits: exits.map((exit) => ({ id: asString(exit.id) || undefined, name: asString(exit.name) })),
    },
    nodes: logicNodes,
    references,
    stats: {
      nodes: nodes.length,
      transitions: edges.length,
      subflows: logicNodes.filter((node) => "subflow" in node).length,
      resourceReferences: references.length,
      unreachableNodes: unreachable.length,
      missingTargets: missingTargets.length,
    },
    warnings,
  };
}

export function validateFlowStructure(flowValue: unknown): {
  valid: boolean;
  errors: FlowIssue[];
  warnings: FlowIssue[];
  stats: JsonObject;
} {
  const flow = asObject(flowValue);
  const nodes = asArray(flow.nodes).map(asObject);
  const exits = asArray(flow.exits).map(asObject);
  const parameters = asArray(flow.parameters).map(asObject);
  const issues: FlowIssue[] = [];
  const error = (code: string, message: string, path?: string) => issues.push({ severity: "error", code, message, path });
  const warning = (code: string, message: string, path?: string) => issues.push({ severity: "warning", code, message, path });

  if (!asString(flow.name)) warning("MISSING_NAME", "Flow has no name.", "name");
  const startCount = nodes.filter((node) => node.isStartNode === true).length;
  if (nodes.length > 0 && startCount !== 1) error("START_NODE_COUNT", `Flow must have exactly one start node; found ${startCount}.`, "nodes");

  const nodeIds = nodes.map((node) => asString(node.id));
  for (const [index, node] of nodes.entries()) {
    const id = asString(node.id);
    const spec = asObject(node.spec);
    if (!id) error("NODE_ID_REQUIRED", "Every node needs an id.", `nodes[${index}].id`);
    if (!asString(spec.url)) error("NODE_URL_REQUIRED", "Every node spec needs a URL.", `nodes[${index}].spec.url`);
  }
  for (const duplicate of duplicates(nodeIds.filter(Boolean))) {
    error("DUPLICATE_NODE_ID", `Duplicate node id ${duplicate}.`, "nodes");
  }

  const parameterNames = parameters.map((parameter) => asString(parameter.name));
  for (const [index, parameter] of parameters.entries()) {
    const name = asString(parameter.name);
    const type = asString(parameter.type);
    if (!name) error("FLOW_PARAMETER_NAME_REQUIRED", "Flow parameters need a name.", `parameters[${index}].name`);
    if (type === "Struct") error("FLOW_PARAMETER_STRUCT", "Flow parameters cannot use Struct type.", `parameters[${index}].type`);
    if (type === "Transition") error("FLOW_PARAMETER_TRANSITION", "Flow parameters cannot use Transition type.", `parameters[${index}].type`);
    if (type === "List" && !parameter.listType) error("FLOW_PARAMETER_LIST_TYPE", "List flow parameters require listType.", `parameters[${index}].listType`);
    if (parameter.isOutput === true && parameter.isPublic !== true) {
      error("PRIVATE_OUTPUT", "Output flow parameters must also be public.", `parameters[${index}]`);
    }
  }
  for (const duplicate of duplicates(parameterNames.filter(Boolean))) {
    error("DUPLICATE_FLOW_PARAMETER", `Duplicate flow parameter ${duplicate}.`, "parameters");
  }

  const exitNames = exits.map((exit) => asString(exit.name)).filter(Boolean);
  const targets = new Set([...nodeIds.filter(Boolean), ...exitNames]);
  for (const exitName of exitNames) {
    if (parameterNames.includes(exitName)) error("EXIT_PARAMETER_COLLISION", `Exit ${exitName} has the same name as a flow parameter.`, "exits");
  }

  const valueIds: string[] = [];
  for (const [nodeIndex, node] of nodes.entries()) {
    walkParameters(asObject(node.parameters), (parameter, path, name) => {
      const id = asString(parameter.id);
      if (!id) error("VALUE_ID_REQUIRED", "Every node parameter needs a unique id.", `nodes[${nodeIndex}].parameters.${path}`);
      else valueIds.push(id);
      if (asString(parameter.type) === "Transition") {
        const target = valueString(parameter.value);
        if (target && !targets.has(target)) {
          error("INVALID_TRANSITION", `Transition ${name} targets missing node/exit ${target}.`, `nodes[${nodeIndex}].parameters.${path}`);
        }
      }
      if (SENSITIVE_NAME.test(name) && hasMeaningfulValue(parameter)) {
        warning("SENSITIVE_LITERAL", `Parameter ${name} contains a literal sensitive-looking value.`, `nodes[${nodeIndex}].parameters.${path}`);
      }
    });
  }
  for (const duplicate of duplicates(valueIds)) error("DUPLICATE_VALUE_ID", `Duplicate node parameter value id ${duplicate}.`, "nodes");

  const logic = buildFlowLogic(flow);
  const stats = asObject(logic.stats);
  if ((stats.unreachableNodes as number | undefined) && Number(stats.unreachableNodes) > 0) {
    warning("UNREACHABLE_NODES", `${stats.unreachableNodes} node(s) are unreachable from the start node.`, "nodes");
  }
  for (const reference of findPortableReferences(flow)) {
    if (!reference.internal) warning("ACCOUNT_RESOURCE_REFERENCE", `${reference.type} ${reference.sourceId} must exist or be mapped in another account.`, reference.location);
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    errors: issues.filter((issue) => issue.severity === "error"),
    warnings: issues.filter((issue) => issue.severity === "warning"),
    stats,
  };
}

export function diffFlowLogic(leftValue: unknown, rightValue: unknown, includeDefaults = false): JsonObject {
  const left = buildFlowLogic(leftValue, includeDefaults);
  const right = buildFlowLogic(rightValue, includeDefaults);
  const leftNodes = asArray(left.nodes).map(asObject);
  const rightNodes = asArray(right.nodes).map(asObject);
  const leftById = new Map(leftNodes.map((node) => [asString(node.id), node]));
  const rightById = new Map(rightNodes.map((node) => [asString(node.id), node]));
  const added = rightNodes.filter((node) => !leftById.has(asString(node.id)));
  const removed = leftNodes.filter((node) => !rightById.has(asString(node.id)));
  const changed: unknown[] = [];
  for (const [id, before] of leftById) {
    const after = rightById.get(id);
    if (!after || stableJson(before) === stableJson(after)) continue;
    changed.push({ id, label: before.label ?? after.label, before, after });
  }
  const leftFlow = asObject(left.flow);
  const rightFlow = asObject(right.flow);
  const flowChanges: JsonObject = {};
  for (const field of ["name", "description", "notes", "customer", "roles", "parameters", "exits"]) {
    if (stableJson(leftFlow[field]) !== stableJson(rightFlow[field])) {
      flowChanges[field] = { before: leftFlow[field], after: rightFlow[field] };
    }
  }
  return {
    format: "evov-flow-logic-diff",
    version: 1,
    equal: added.length === 0 && removed.length === 0 && changed.length === 0 && Object.keys(flowChanges).length === 0,
    summary: {
      nodesAdded: added.length,
      nodesRemoved: removed.length,
      nodesChanged: changed.length,
      flowFieldsChanged: Object.keys(flowChanges).length,
    },
    flowChanges,
    nodesAdded: added,
    nodesRemoved: removed,
    nodesChanged: changed,
  };
}

export function applyFlowEdits(flowValue: unknown, edits: FlowEditOperation[]): FlowEditResult {
  if (edits.length === 0) throw new Error("At least one flow edit operation is required.");
  const original = deepClone(asObject(flowValue));
  const flow = deepClone(original);
  if (!Array.isArray(flow.nodes)) flow.nodes = [];
  const applied: Array<Record<string, unknown>> = [];

  for (const edit of edits) {
    const nodes = asArray(flow.nodes).map(asObject);
    if (edit.op === "set") {
      const node = resolveNode(nodes, edit.node);
      const parameters = asObject(node.parameters);
      const match = resolveParameter(parameters, edit.parameter, nodeLabel(node));
      if (asString(match.parameter.type) === "Transition") {
        throw new Error(`Parameter ${match.name} on ${nodeLabel(node)} is a transition; use flow connect/disconnect.`);
      }
      match.parameter.value = wrapEditedValue(edit.value, match.parameter);
      if (edit.source) match.parameter.source = edit.source;
      node.parameters = parameters;
      applied.push({ op: edit.op, node: asString(node.id), parameter: match.name, source: edit.source });
      continue;
    }

    if (edit.op === "connect" || edit.op === "disconnect") {
      const node = resolveNode(nodes, edit.node);
      const parameters = asObject(node.parameters);
      const match = resolveParameter(parameters, edit.transition, nodeLabel(node));
      if (asString(match.parameter.type) !== "Transition") {
        throw new Error(`Parameter ${match.name} on ${nodeLabel(node)} is not a Transition.`);
      }
      if (edit.op === "disconnect") {
        match.parameter.value = {};
        applied.push({ op: edit.op, node: asString(node.id), transition: match.name });
      } else {
        const target = resolveTransitionTarget(flow, edit.target);
        match.parameter.value = { stringValue: target.id };
        applied.push({ op: edit.op, node: asString(node.id), transition: match.name, target: target.id, targetKind: target.kind });
      }
      node.parameters = parameters;
      continue;
    }

    if (edit.op === "add-node") {
      const node = deepClone(asObject(edit.node));
      if (Object.keys(node).length === 0) throw new Error("add-node requires a node object.");
      if (!asString(node.id)) node.id = crypto.randomUUID();
      if (nodes.some((candidate) => asString(candidate.id) === asString(node.id))) {
        throw new Error(`Node id ${asString(node.id)} already exists.`);
      }
      if (node.isStartNode === undefined) node.isStartNode = nodes.length === 0;
      const parameters = asObject(node.parameters);
      walkParameters(parameters, (parameter) => {
        if (!asString(parameter.id)) parameter.id = crypto.randomUUID();
      });
      node.parameters = parameters;
      (flow.nodes as unknown[]).push(node);
      applied.push({ op: edit.op, node: asString(node.id), label: nodeLabel(node), start: node.isStartNode === true });
      continue;
    }

    const node = resolveNode(nodes, edit.node);
    const nodeId = asString(node.id);
    const incoming = transitionParameters(nodes).filter((item) => valueString(item.parameter.value) === nodeId);
    if (incoming.length > 0 && !edit.disconnectIncoming) {
      throw new Error(
        `Cannot remove ${nodeLabel(node)}; ${incoming.length} transition(s) still target it. ` +
        "Use --disconnect-incoming or redirect them first.",
      );
    }
    for (const item of incoming) item.parameter.value = {};
    flow.nodes = nodes.filter((candidate) => candidate !== node);
    applied.push({
      op: edit.op,
      node: nodeId,
      label: nodeLabel(node),
      disconnectedIncoming: edit.disconnectIncoming ? incoming.length : 0,
    });
  }

  const validation = validateFlowStructure(flow);
  return {
    flow,
    patch: { nodes: asArray(flow.nodes) },
    operations: applied,
    validation,
    diff: diffFlowLogic(original, flow),
  };
}

export function buildPortablePackage(
  flowsValue: unknown[],
  fields: { customerFields?: unknown[]; endpointFields?: unknown[]; systemFields?: unknown[] } = {},
  source: PortableFlowPackage["source"] = {},
): PortableFlowPackage {
  const flows = flowsValue.map((flow) => deepClone(asObject(flow)));
  const flowIds = new Set(flows.map((flow) => asString(flow.id)).filter(Boolean));
  const references: PortableReference[] = [];
  const warnings: string[] = [];
  for (const [flowIndex, flow] of flows.entries()) {
    const refs = findPortableReferences(flow, ["package", "flows", flowIndex]);
    for (const ref of refs) {
      // The backend importer remaps only /flows/start?flowId=... node URLs.
      // Flow IDs stored as ordinary parameter values need an explicit existing destination mapping.
      if (ref.type === "Flow" && ref.encoding === "flow-url" && flowIds.has(ref.sourceId)) ref.internal = true;
      references.push(ref);
    }
    const customerId = asString(flow.customerId);
    if (customerId) {
      references.push(reference(
        "Customer",
        customerId,
        asString(flow.customerName) || undefined,
        ["package", "flows", flowIndex, "customerId"],
        `${asString(flow.name) || flowIndex}.metadata.customerId`,
        "value",
      ));
    }
    if (asArray(flow.tags).length > 0) warnings.push(`Flow ${asString(flow.name) || flowIndex} has tags; backend package import does not preserve tag assignments.`);
    if (asString(flow.customerId)) warnings.push(`Flow ${asString(flow.name) || flowIndex} has a customer assignment; backend package import creates flows at account scope.`);
    if (asString(flow.description)) warnings.push(`Flow ${asString(flow.name) || flowIndex} has a description; backend package import does not preserve flow descriptions.`);
    if (asArray(flow.roles).length > 0) warnings.push(`Flow ${asString(flow.name) || flowIndex} has role assignments; backend package import does not preserve flow roles.`);
    if (validateFlowStructure(flow).warnings.some((issue) => issue.code === "SENSITIVE_LITERAL")) {
      warnings.push(`Flow ${asString(flow.name) || flowIndex} contains sensitive-looking literal values. Portable packages preserve them; store the export securely.`);
    }
  }
  return {
    kind: "evov-portable-flow-package",
    version: 1,
    exportedAt: new Date().toISOString(),
    source,
    package: {
      flows,
      customerFields: fields.customerFields ?? [],
      endpointFields: fields.endpointFields ?? [],
      systemFields: fields.systemFields ?? [],
    },
    references,
    warnings: [...new Set(warnings)],
  };
}

export function findPortableReferences(flowValue: unknown, prefix: JsonPath = []): PortableReference[] {
  const flow = asObject(flowValue);
  const references: PortableReference[] = [];
  const flowName = asString(flow.name) || "flow";

  for (const [parameterIndex, rawParameter] of asArray(flow.parameters).entries()) {
    const parameter = asObject(rawParameter);
    const type = asString(parameter.type);
    const id = valueString(parameter.defaultValue);
    if (RESOURCE_TYPES.has(type) && id) {
      references.push(reference(type, id, undefined, [...prefix, "parameters", parameterIndex, "defaultValue", "stringValue"], `${flowName}.parameter:${asString(parameter.name)}`, "value"));
    }
  }

  for (const [nodeIndex, rawNode] of asArray(flow.nodes).entries()) {
    const node = asObject(rawNode);
    const nodeName = nodeLabel(node);
    const spec = asObject(node.spec);
    const url = asString(spec.url);
    const subflowId = flowIdFromUrl(url);
    if (subflowId) {
      references.push(reference("Flow", subflowId, asString(spec.name), [...prefix, "nodes", nodeIndex, "spec", "url"], `${flowName}.${nodeName}.subflow`, "flow-url"));
    }
    walkParameters(asObject(node.parameters), (parameter, path, parameterName) => {
      const type = asString(parameter.type);
      const source = asString(parameter.source) || "Value";
      if (source !== "Value" || parameter.isOutput === true || !RESOURCE_TYPES.has(type)) return;
      const id = valueString(parameter.value);
      if (!id) return;
      references.push(reference(
        type,
        id,
        undefined,
        [...prefix, "nodes", nodeIndex, "parameters", ...path.split("."), "value", "stringValue"],
        `${flowName}.${nodeName}.${parameterName}`,
        "value",
      ));
    });
  }
  return dedupeReferences(references);
}

export function findCustomFieldDependencies(flowsValue: unknown[]): {
  customerFields: string[];
  endpointFields: string[];
  systemFields: string[];
} {
  const customer = new Set<string>();
  const endpoint = new Set<string>();
  const system = new Set<string>();
  for (const flowValue of flowsValue) {
    const flow = asObject(flowValue);
    for (const rawNode of asArray(flow.nodes)) {
      const node = asObject(rawNode);
      walkParameters(asObject(node.parameters), (parameter) => {
        const source = asString(parameter.source);
        const field = asString(parameter.referenceId);
        if (!field) return;
        if (source === "Customer") customer.add(field);
        else if (source === "Endpoint" || source === "User") endpoint.add(field);
        else if (source === "System") system.add(field);
      });
    }
  }
  return {
    customerFields: [...customer].sort(),
    endpointFields: [...endpoint].sort(),
    systemFields: [...system].sort(),
  };
}

export function resolvePortableReferences(
  references: PortableReference[],
  candidates: ResourceCandidate[],
  explicitMappings: Record<string, string> = {},
): ReferenceResolution[] {
  return references.map((ref) => {
    if (ref.internal) return { reference: ref, status: "internal" };
    const explicit = explicitMappings[ref.sourceId] ?? (ref.label ? explicitMappings[`${ref.type}:${ref.label}`] : undefined);
    if (explicit) return { reference: ref, status: "mapped", destinationId: explicit };
    const matches = candidates.filter((candidate) => candidateMatches(ref, candidate));
    if (matches.length === 1) return { reference: ref, status: "resolved", destinationId: matches[0].id };
    if (matches.length === 0) return { reference: ref, status: "unresolved" };
    return {
      reference: ref,
      status: "ambiguous",
      candidates: matches.map((candidate) => ({ id: candidate.id, type: candidate.type, label: candidate.labels[0] })),
    };
  });
}

export function applyPortableResolutions(
  portable: PortableFlowPackage,
  resolutions: ReferenceResolution[],
): PortableFlowPackage["package"] {
  const output = deepClone(portable.package);
  for (const resolution of resolutions) {
    if (!resolution.destinationId || resolution.status === "internal") continue;
    const relativePath = resolution.reference.path[0] === "package"
      ? resolution.reference.path.slice(1)
      : resolution.reference.path;
    if (resolution.reference.encoding === "flow-url") {
      const current = asString(getAtPath(output as unknown as JsonObject, relativePath));
      setAtPath(output as unknown as JsonObject, relativePath, replaceFlowId(current, resolution.destinationId));
    } else {
      setAtPath(output as unknown as JsonObject, relativePath, resolution.destinationId);
    }
  }
  return output;
}

export function addReferenceLabels(
  portable: PortableFlowPackage,
  labels: Record<string, string | undefined>,
): PortableFlowPackage {
  return {
    ...portable,
    references: portable.references.map((ref) => ({ ...ref, label: ref.label ?? labels[`${ref.type}:${ref.sourceId}`] })),
  };
}

function compactParameter(name: string, parameter: JsonObject, includeDefaults: boolean): unknown {
  const type = asString(parameter.type);
  const source = asString(parameter.source) || "Value";
  const base: JsonObject = { type };
  if (parameter.isAsync === true) base.async = true;
  if (source === "Expression") return { ...base, from: "Expression", expression: asString(parameter.expression) };
  if (source !== "Value") return { ...base, from: source, field: asString(parameter.referenceId) || undefined };

  const listParameters = asArray(parameter.listParameters);
  if (listParameters.length > 0) {
    const items = listParameters.map((item) => compactParameterMap(asObject(item), includeDefaults)).filter((item) => Object.keys(item).length > 0);
    return items.length > 0 || includeDefaults ? { ...base, items } : undefined;
  }
  const structParameters = asObject(parameter.structParameters);
  if (Object.keys(structParameters).length > 0) {
    const fields = compactParameterMap(structParameters, includeDefaults);
    return Object.keys(fields).length > 0 || includeDefaults ? { ...base, fields } : undefined;
  }
  const value = unwrapValue(parameter.value);
  if (!includeDefaults && !isMeaningful(value)) return undefined;
  return { ...base, value: SENSITIVE_NAME.test(name) && isMeaningful(value) ? "[REDACTED]" : value };
}

function compactParameterMap(map: JsonObject, includeDefaults: boolean): JsonObject {
  const output: JsonObject = {};
  for (const [name, value] of Object.entries(map)) {
    const compact = compactParameter(name, asObject(value), includeDefaults);
    if (compact !== undefined) output[name] = compact;
  }
  return output;
}

function compactFlowParameter(value: unknown): JsonObject {
  const parameter = asObject(value);
  return {
    name: asString(parameter.name),
    type: asString(parameter.type),
    public: parameter.isPublic === true || undefined,
    output: parameter.isOutput === true || undefined,
    knob: parameter.isKnob === true || undefined,
    default: unwrapValue(parameter.defaultValue),
  };
}

function walkParameters(
  map: JsonObject,
  visit: (parameter: JsonObject, path: string, name: string) => void,
  prefix = "",
): void {
  for (const [name, value] of Object.entries(map)) {
    const parameter = asObject(value);
    const path = prefix ? `${prefix}.${name}` : name;
    visit(parameter, path, name);
    for (const [index, item] of asArray(parameter.listParameters).entries()) {
      walkParameters(asObject(item), visit, `${path}.listParameters.${index}`);
    }
    const struct = asObject(parameter.structParameters);
    if (Object.keys(struct).length > 0) walkParameters(struct, visit, `${path}.structParameters`);
  }
}

function resolveNode(nodes: JsonObject[], selector: string): JsonObject {
  const byId = nodes.filter((node) => asString(node.id) === selector);
  if (byId.length === 1) return byId[0];
  const wanted = normalizeLabel(selector);
  const byLabel = nodes.filter((node) => normalizeLabel(nodeLabel(node)) === wanted);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`Node selector ${selector} is ambiguous; use an exact node id.`);
  throw new Error(`Node ${selector} was not found.`);
}

function resolveParameter(
  parameters: JsonObject,
  selector: string,
  nodeName: string,
): { name: string; parameter: JsonObject } {
  if (selector in parameters) return { name: selector, parameter: asObject(parameters[selector]) };
  const matches = Object.entries(parameters)
    .filter(([name]) => normalizeLabel(name) === normalizeLabel(selector))
    .map(([name, value]) => ({ name, parameter: asObject(value) }));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Parameter ${selector} is ambiguous on ${nodeName}.`);
  throw new Error(`Parameter ${selector} was not found on ${nodeName}.`);
}

function resolveTransitionTarget(flow: JsonObject, selector: string): { id: string; kind: "node" | "exit" } {
  const nodes = asArray(flow.nodes).map(asObject);
  try {
    return { id: asString(resolveNode(nodes, selector).id), kind: "node" };
  } catch (error) {
    if ((error as Error).message.includes("ambiguous")) throw error;
    const wanted = normalizeLabel(selector);
    const exits = asArray(flow.exits).map(asObject).filter((exit) => {
      return asString(exit.name) === selector || normalizeLabel(asString(exit.name)) === wanted;
    });
    if (exits.length === 1) return { id: asString(exits[0].name), kind: "exit" };
    if (exits.length > 1) throw new Error(`Exit selector ${selector} is ambiguous.`);
    throw new Error(`Transition target ${selector} is not a node id/label or exit name.`);
  }
}

function transitionParameters(nodes: JsonObject[]): Array<{ node: JsonObject; name: string; parameter: JsonObject }> {
  const output: Array<{ node: JsonObject; name: string; parameter: JsonObject }> = [];
  for (const node of nodes) {
    for (const [name, value] of Object.entries(asObject(node.parameters))) {
      const parameter = asObject(value);
      if (asString(parameter.type) === "Transition") output.push({ node, name, parameter });
    }
  }
  return output;
}

function wrapEditedValue(value: unknown, parameter: JsonObject): JsonObject {
  if (value === null || value === undefined) return {};
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    const wrapperKeys = ["stringValue", "boolValue", "numberValue", "listValue", "structValue"];
    if (wrapperKeys.some((key) => key in object)) return deepClone(object);
  }
  const existing = asObject(parameter.value);
  if ("listValue" in existing || asString(parameter.type) === "List") return { listValue: deepClone(value) };
  if ("structValue" in existing || asString(parameter.type) === "Struct") return { structValue: deepClone(value) };
  throw new Error("Array/object values require a List/Struct parameter or a full value wrapper object.");
}

function nodeLabel(node: JsonObject): string {
  const spec = asObject(node.spec);
  return asString(node.name) || asString(spec.name) || asString(spec.typeName) || asString(node.id) || "(unnamed node)";
}

function reachableNodeIds(starts: string[], edges: Array<{ from: string; target: string; kind: string }>): Set<string> {
  const reached = new Set(starts.filter(Boolean));
  const pending = [...reached];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const edge of edges.filter((candidate) => candidate.from === current && candidate.kind === "node")) {
      if (!reached.has(edge.target)) {
        reached.add(edge.target);
        pending.push(edge.target);
      }
    }
  }
  return reached;
}

function candidateMatches(referenceValue: PortableReference, candidate: ResourceCandidate): boolean {
  if (!typeMatches(referenceValue.type, candidate.type)) return false;
  if (candidate.id === referenceValue.sourceId) return true;
  if (!referenceValue.label) return false;
  const wanted = normalizeLabel(referenceValue.label);
  return candidate.labels.some((label) => normalizeLabel(label) === wanted);
}

function typeMatches(referenceType: string, candidateType: string): boolean {
  if (ENDPOINT_RESOURCE_TYPES.has(referenceType)) {
    if (candidateType === "Endpoint") return true;
    const aliases: Record<string, string[]> = {
      Assistant: ["Assistant", "AssistantBot"],
      FaxNumber: ["Fax", "FaxNumber", "PhoneNumber"],
      PhoneNumber: ["PhoneNumber"],
      SipTrunk: ["SipTrunk"],
      Team: ["Team"],
      User: ["User"],
      Endpoint: ["PhoneNumber", "User", "Team", "Email", "Fax", "EmergencyAddress", "SipTrunk", "AssistantBot"],
    };
    return (aliases[referenceType] ?? []).includes(candidateType);
  }
  if (referenceType === "AudioFile") return candidateType === "File" || candidateType === "AudioFile";
  return referenceType === candidateType;
}

function reference(
  type: string,
  sourceId: string,
  label: string | undefined,
  path: JsonPath,
  location: string,
  encoding: PortableReference["encoding"],
): PortableReference {
  return { type, sourceId, label: label || undefined, path, location, encoding };
}

function dedupeReferences(refs: PortableReference[]): PortableReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = JSON.stringify(ref.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flowIdFromUrl(url: string): string | undefined {
  const match = /(?:[?&])flowId=([^&#]+)/i.exec(url);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function replaceFlowId(url: string, id: string): string {
  return url.replace(/([?&]flowId=)[^&#]*/i, `$1${encodeURIComponent(id)}`);
}

function valueString(value: unknown): string {
  const obj = asObject(value);
  return asString(obj.stringValue) || (typeof value === "string" ? value : "");
}

function unwrapValue(value: unknown): unknown {
  const obj = asObject(value);
  if (obj.boolValue !== undefined && obj.boolValue !== null) return obj.boolValue;
  if (obj.numberValue !== undefined && obj.numberValue !== null) return obj.numberValue;
  if (obj.listValue !== undefined && obj.listValue !== null) return obj.listValue;
  if (obj.structValue !== undefined && obj.structValue !== null) return obj.structValue;
  if (obj.stringValue !== undefined && obj.stringValue !== null) return obj.stringValue;
  return value === null || value === undefined ? null : value;
}

function hasMeaningfulValue(parameter: JsonObject): boolean {
  return isMeaningful(unwrapValue(parameter.value)) || asArray(parameter.listParameters).length > 0 || Object.keys(asObject(parameter.structParameters)).length > 0;
}

function isMeaningful(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as JsonObject).length > 0;
  return true;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicatesFound = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicatesFound.add(value);
    seen.add(value);
  }
  return [...duplicatesFound];
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function getAtPath(root: JsonObject, path: JsonPath): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") current = current[part];
    else if (current && typeof current === "object") current = (current as JsonObject)[String(part)];
    else return undefined;
  }
  return current;
}

function setAtPath(root: JsonObject, path: JsonPath, value: unknown): void {
  if (path.length === 0) return;
  let current: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(current) && typeof part === "number") current = current[part];
    else current = asObject(current)[String(part)];
  }
  const last = path[path.length - 1];
  if (Array.isArray(current) && typeof last === "number") current[last] = value;
  else if (current && typeof current === "object") (current as JsonObject)[String(last)] = value;
}
