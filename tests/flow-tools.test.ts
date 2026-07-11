import { describe, expect, it } from "vitest";

import {
  addReferenceLabels,
  applyFlowEdits,
  applyPortableResolutions,
  buildFlowLogic,
  buildPortablePackage,
  diffFlowLogic,
  findCustomFieldDependencies,
  resolvePortableReferences,
  validateFlowStructure,
} from "../src/flow-tools.js";

function parameter(
  id: string,
  type: string,
  value: string | boolean | number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    source: "Value",
    value: typeof value === "string"
      ? { stringValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : typeof value === "number"
          ? { numberValue: value }
          : {},
    ...extra,
  };
}

function sampleFlow(): Record<string, unknown> {
  return {
    id: "flow-main",
    name: "Main Support",
    accountId: "source-account",
    customerId: "source-customer",
    customerName: "Source Customer",
    tags: [{ id: "tag-source", name: "Production" }],
    roles: ["PhoneNumberRouting"],
    parameters: [],
    exits: [{ id: "exit-1", name: "Escalate" }],
    nodes: [
      {
        id: "start",
        isStartNode: true,
        name: "Check support",
        spec: { name: "Boolean Comparison", typeName: "BooleanComparisonNode", url: "/json/reply/BooleanComparisonNode" },
        parameters: {
          ApiKey: parameter("p-secret", "String", "top-secret"),
          Enabled: parameter("p-enabled", "Boolean", false),
          Team: parameter("p-team", "Team", "team-source"),
          Yes: parameter("p-yes", "Transition", "dial"),
          No: parameter("p-no", "Transition", "Escalate"),
        },
      },
      {
        id: "dial",
        isStartNode: false,
        spec: { name: "Dial", typeName: "DialNode", url: "/json/reply/DialNode" },
        parameters: {
          TimeoutInSeconds: parameter("p-timeout", "Number", 30),
          Done: parameter("p-done", "Transition", "subflow"),
        },
      },
      {
        id: "subflow",
        isStartNode: false,
        spec: { name: "Shared Voicemail", typeName: "FlowNode", url: "/flows/start?flowId=flow-shared" },
        parameters: {},
      },
    ],
  };
}

describe("flow logic", () => {
  it("condenses branches and meaningful inputs while redacting secrets", () => {
    const logic = buildFlowLogic(sampleFlow()) as {
      nodes: Array<Record<string, unknown>>;
      references: Array<Record<string, unknown>>;
      stats: Record<string, number>;
    };

    const start = logic.nodes[0] as {
      inputs: Record<string, { value?: unknown }>;
      transitions: Array<Record<string, unknown>>;
    };
    expect(start.inputs.ApiKey.value).toBe("[REDACTED]");
    expect(start.inputs.Enabled).toBeUndefined();
    expect(start.inputs.Team).toMatchObject({ type: "Team", value: "team-source" });
    expect(start.transitions).toEqual([
      expect.objectContaining({ on: "Yes", target: "dial", targetLabel: "Dial", kind: "node" }),
      expect.objectContaining({ on: "No", target: "Escalate", kind: "exit" }),
    ]);
    expect(logic.nodes[2]).toMatchObject({ subflow: { id: "flow-shared", name: "Shared Voicemail" } });
    expect(logic.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "Team", id: "team-source" }),
      expect.objectContaining({ type: "Flow", id: "flow-shared" }),
    ]));
    expect(logic.stats).toMatchObject({ nodes: 3, transitions: 3, subflows: 1, unreachableNodes: 0 });
  });
});

describe("flow validation", () => {
  it("matches important backend graph validation and flags sensitive literals", () => {
    const valid = validateFlowStructure(sampleFlow());
    expect(valid.valid).toBe(true);
    expect(valid.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SENSITIVE_LITERAL" }),
      expect.objectContaining({ code: "ACCOUNT_RESOURCE_REFERENCE" }),
    ]));

    const broken = sampleFlow();
    const nodes = broken.nodes as Array<Record<string, unknown>>;
    ((nodes[0].parameters as Record<string, Record<string, unknown>>).Yes.value as Record<string, unknown>).stringValue = "missing";
    const result = validateFlowStructure(broken);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    ]));
  });
});

describe("flow logic diff", () => {
  it("reports changed branches and meaningful node values without raw-flow noise", () => {
    const left = sampleFlow();
    const right = sampleFlow();
    const nodes = right.nodes as Array<Record<string, unknown>>;
    const startParameters = nodes[0].parameters as Record<string, Record<string, unknown>>;
    (startParameters.Yes.value as Record<string, unknown>).stringValue = "Escalate";
    const dialParameters = nodes[1].parameters as Record<string, Record<string, unknown>>;
    (dialParameters.TimeoutInSeconds.value as Record<string, unknown>).numberValue = 45;

    const diff = diffFlowLogic(left, right) as {
      equal: boolean;
      summary: Record<string, number>;
      nodesChanged: Array<Record<string, unknown>>;
    };
    expect(diff.equal).toBe(false);
    expect(diff.summary).toMatchObject({ nodesAdded: 0, nodesRemoved: 0, nodesChanged: 2 });
    expect(diff.nodesChanged.map((node) => node.id)).toEqual(["start", "dial"]);
    expect(JSON.stringify(diff)).not.toContain("top-secret");
  });
});

describe("targeted flow editing", () => {
  it("sets values and reconnects branches while preserving the complete node array", () => {
    const result = applyFlowEdits(sampleFlow(), [
      { op: "set", node: "dial", parameter: "TimeoutInSeconds", value: 45 },
      { op: "connect", node: "start", transition: "Yes", target: "Escalate" },
    ]);

    expect(result.validation.valid).toBe(true);
    expect(result.patch.nodes).toHaveLength(3);
    const nodes = result.flow.nodes as Array<Record<string, unknown>>;
    const dial = nodes[1].parameters as Record<string, Record<string, unknown>>;
    expect(dial.TimeoutInSeconds.value).toEqual({ numberValue: 45 });
    const start = nodes[0].parameters as Record<string, Record<string, unknown>>;
    expect(start.Yes.value).toEqual({ stringValue: "Escalate" });
    expect(result.diff).toMatchObject({ equal: false, summary: { nodesChanged: 2 } });
  });

  it("blocks removal with inbound transitions unless they are explicitly disconnected", () => {
    expect(() => applyFlowEdits(sampleFlow(), [{ op: "remove-node", node: "subflow" }]))
      .toThrow(/transition.*still target/i);

    const result = applyFlowEdits(sampleFlow(), [{ op: "remove-node", node: "subflow", disconnectIncoming: true }]);
    expect(result.validation.valid).toBe(true);
    expect(result.patch.nodes).toHaveLength(2);
    const dial = (result.flow.nodes as Array<Record<string, unknown>>)[1];
    expect(((dial.parameters as Record<string, Record<string, unknown>>).Done.value)).toEqual({});
  });

  it("generates missing node and value ids when adding a node", () => {
    const result = applyFlowEdits(sampleFlow(), [{
      op: "add-node",
      node: {
        spec: { name: "Play message", typeName: "PlayNode", url: "/json/reply/PlayNode" },
        parameters: { Text: { type: "String", source: "Value", value: { stringValue: "Hello" } } },
      },
    }]);
    const added = (result.flow.nodes as Array<Record<string, unknown>>)[3];
    expect(added.id).toEqual(expect.any(String));
    expect((added.parameters as Record<string, Record<string, unknown>>).Text.id).toEqual(expect.any(String));
    expect(result.validation.valid).toBe(true);
  });
});

describe("portable flow packages", () => {
  it("discovers only custom fields actually consumed by node parameters", () => {
    const flow = sampleFlow();
    const nodes = flow.nodes as Array<Record<string, unknown>>;
    const parameters = nodes[0].parameters as Record<string, Record<string, unknown>>;
    parameters.CustomerTier = { id: "p-tier", type: "String", source: "Customer", referenceId: "Tier", value: {} };
    parameters.AgentCode = { id: "p-agent", type: "String", source: "User", referenceId: "AgentCode", value: {} };
    parameters.Region = { id: "p-region", type: "String", source: "System", referenceId: "Region", value: {} };

    expect(findCustomFieldDependencies([flow])).toEqual({
      customerFields: ["Tier"],
      endpointFields: ["AgentCode"],
      systemFields: ["Region"],
    });
  });

  it("maps named account resources and leaves packaged subflow references for backend remapping", () => {
    const shared = {
      id: "flow-shared",
      name: "Shared Voicemail",
      parameters: [],
      exits: [],
      nodes: [],
      tags: [],
    };
    let portable = buildPortablePackage([sampleFlow(), shared], {}, {
      accountId: "source-account",
      accountName: "Source",
      env: "staging",
    });
    portable = addReferenceLabels(portable, { "Team:team-source": "Support Team" });

    const teamReference = portable.references.find((reference) => reference.type === "Team")!;
    const flowReference = portable.references.find((reference) => reference.type === "Flow")!;
    expect(teamReference).toMatchObject({ sourceId: "team-source", label: "Support Team" });
    expect(teamReference.internal).toBeUndefined();
    expect(flowReference).toMatchObject({ sourceId: "flow-shared", internal: true });
    expect(portable.warnings.join(" ")).toMatch(/tags|customer assignment/i);

    const resolutions = resolvePortableReferences(portable.references, [
      { id: "team-destination", type: "Team", labels: ["Support Team"] },
    ]);
    expect(resolutions.find((resolution) => resolution.reference.type === "Team")).toMatchObject({
      status: "resolved",
      destinationId: "team-destination",
    });
    expect(resolutions.find((resolution) => resolution.reference.type === "Flow")).toMatchObject({ status: "internal" });
    expect(portable.warnings.join(" ")).toMatch(/flow roles/i);

    const backend = applyPortableResolutions(portable, resolutions);
    const main = backend.flows[0];
    const start = (main.nodes as Array<Record<string, unknown>>)[0];
    const team = (start.parameters as Record<string, Record<string, unknown>>).Team;
    expect((team.value as Record<string, unknown>).stringValue).toBe("team-destination");
    const subflow = (main.nodes as Array<Record<string, unknown>>)[2];
    expect((subflow.spec as Record<string, unknown>).url).toBe("/flows/start?flowId=flow-shared");
  });

  it("reports ambiguous and unresolved references for preflight", () => {
    let portable = buildPortablePackage([sampleFlow()]);
    portable = addReferenceLabels(portable, { "Team:team-source": "Support Team", "Flow:flow-shared": "Shared Voicemail" });
    const resolutions = resolvePortableReferences(portable.references, [
      { id: "team-1", type: "Team", labels: ["Support Team"] },
      { id: "team-2", type: "Team", labels: ["support team"] },
    ]);
    expect(resolutions.find((resolution) => resolution.reference.type === "Team")?.status).toBe("ambiguous");
    expect(resolutions.find((resolution) => resolution.reference.type === "Flow")?.status).toBe("unresolved");
  });
});
