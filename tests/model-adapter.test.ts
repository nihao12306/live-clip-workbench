import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekModelAdapter,
  heuristicCandidates,
  mergeModelCandidates,
} from "../src/main/model-adapter";
import { DEFAULT_CROP_PRESET, DEFAULT_SUBTITLE_TEMPLATE } from "../src/shared/constants";
import type { AccountProfile, TranscriptSegment } from "../src/shared/types";

const account: AccountProfile = {
  id: "account",
  name: "测试老师",
  vertical: "教育",
  audience: "家长",
  persona: "专业",
  stance: "理性",
  forbiddenTopics: [],
  sensitiveWords: [],
  preferenceSummary: "",
  samplePaths: [],
  subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE,
  cropPreset: DEFAULT_CROP_PRESET,
  coverTemplate: "bold",
  minClipSeconds: 30,
  maxClipSeconds: 180,
  createdAt: "",
  updatedAt: "",
};

describe("content-first heuristic candidates", () => {
  it("ends at natural topic boundaries instead of cutting every clip at min length", () => {
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 10, text: "很多家长以为学校选择只看分数。", confidence: "source" },
      { id: "2", start: 10, end: 22, text: "真正关键的是目标和反馈，所以要先看孩子需求。", confidence: "source" },
      { id: "3", start: 22, end: 27, text: "另外，再说专业选择。", confidence: "source" },
      { id: "4", start: 27, end: 40, text: "专业要看兴趣和就业方向，不能只看排名。", confidence: "source" },
      { id: "5", start: 40, end: 58, text: "建议结合学科基础和发展规划，再做决定。", confidence: "source" },
    ];
    const candidates = heuristicCandidates({
      account,
      task: {} as never,
      transcript,
    });
    expect(candidates.map((candidate) => candidate.segmentIds)).toEqual([
      ["1", "2"],
      ["3", "4", "5"],
    ]);
    expect(candidates[0].segmentIds.length).not.toBe(candidates[1].segmentIds.length);
  });
});

describe("DeepSeek API adapter", () => {
  const config = {
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  };

  it("reports a real connectivity result and usage instead of only checking whether a key exists", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          "Bearer sk-test",
        );
        return new Response(
          JSON.stringify({
            id: "req-health",
            model: "deepseek-v4-flash",
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 3,
              total_tokens: 15,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const result = await adapter.testConnection({ model: "deepseek-v4-flash" });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("deepseek-v4-flash");
    expect(requestBody?.model).toBe("deepseek-v4-flash");
    expect(result.usage?.totalTokens).toBe(15);
    expect(adapter.getLastCallInfo()?.requestId).toBe("req-health");
    vi.unstubAllGlobals();
  });

  it("passes account learning context into platform-copy generation", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "req-copy-context",
            model: config.model,
            choices: [{
              message: {
                content: JSON.stringify({
                  title: "当前视频标题",
                  body: "当前视频正文",
                  hashtags: ["教育"],
                  pinnedComment: "欢迎讨论",
                  coverText: "当前视频",
                }),
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    await adapter.generatePlatformCopy({
      accountName: "测试老师",
      title: "当前视频标题",
      hookText: "当前视频钩子",
      transcript: "当前直播原话",
      platform: "douyin",
      blockedTerms: ["禁词"],
      accountContext: {
        audience: "广东家长",
        selectionPrinciples: "一条只解决一个选择",
        sampleTranscript: "样片结构参考：先给结论，再给证据和条件化建议。",
        sampleLearningProfile: {
          version: 1,
          generatedAt: "2026-08-14T00:00:00.000Z",
          sampleCount: 2,
          learnedSampleCount: 2,
          summary: "结构画像测试",
          hookPatterns: ["先给结论"],
          structurePatterns: ["证据链"],
          audienceSignals: ["具体人群"],
          evidenceSignals: ["数据"],
          toneSignals: ["理性克制"],
          recommendationPatterns: ["条件化建议"],
          avoidPatterns: ["不复制原句"],
          performanceSignals: [],
        },
      },
      recentFeedback: [{
        decision: "rejected",
        reason: "开头不完整",
      }],
    });
    const messages = requestBody?.messages as Array<{ role?: string; content?: string }>;
    const userContent = messages.find((message) => message.role === "user")?.content ?? "";
    expect(userContent).toContain("样片结构参考");
    expect(userContent).toContain("一条只解决一个选择");
    expect(userContent).toContain("结构画像测试");
    expect(userContent).toContain("开头不完整");
    expect(requestBody?.max_tokens).toBe(384_000);
    expect(requestBody?.thinking).toEqual({ type: "disabled" });
    vi.unstubAllGlobals();
  });

  it("includes sample learning context in every analysis window", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: `req-analysis-${requestBodies.length}`,
            model: config.model,
            choices: [{ message: { content: '{"candidates":[]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const sampleTranscript = "样片参考：结论、证据、边界和条件化建议。";
    const longSegment = "完整论证。".repeat(5_000);
    await adapter.analyze(
      {
        account: { ...account, sampleTranscript },
        task: {} as never,
        transcript: [
          { id: "long-1", start: 0, end: 10, text: longSegment, confidence: "source" },
          { id: "long-2", start: 10, end: 20, text: longSegment, confidence: "source" },
        ],
      },
      [],
    );
    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies) {
      const messages = body.messages as Array<{ role?: string; content?: string }>;
      const userContent = messages.find((message) => message.role === "user")?.content ?? "";
      expect(userContent).toContain(sampleTranscript);
    }
    vi.unstubAllGlobals();
  });

  it("surfaces API failures and never silently returns local heuristic candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid key", { status: 401 })),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).rejects.toThrow("HTTP 401");
    expect(adapter.getLastCallInfo()?.status).toBe("error");
    vi.unstubAllGlobals();
  });

  it("retries a terminated long request before failing", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("terminated");
        return new Response(
          JSON.stringify({
            id: "req-retry",
            model: config.model,
            choices: [{ message: { content: '{"candidates":[]}' } }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).resolves.toEqual([]);
    expect(calls).toBe(2);
    expect(adapter.getLastCallInfo()?.status).toBe("success");
    vi.unstubAllGlobals();
  });

  it("backs off and retries transient DeepSeek 5xx responses", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("temporarily unavailable", { status: 503 });
        return new Response(
          JSON.stringify({
            id: "req-503-retry",
            model: config.model,
            choices: [{ message: { content: '{"candidates":[]}' } }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).resolves.toEqual([]);
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });

  it("reads streamed DeepSeek analysis responses", async () => {
    const chunks = [
      `data: ${JSON.stringify({ id: "req-stream", model: config.model, choices: [{ delta: { content: '{"candidates":' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "[]}" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).resolves.toEqual([]);
    expect(adapter.getLastCallInfo()?.usage?.totalTokens).toBe(7);
    vi.unstubAllGlobals();
  });

  it("recovers complete candidates when the final JSON object is truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "req-truncated",
            model: config.model,
            choices: [{
              message: {
                content: '{"candidates":[{"topicId":"topic-1","title":"一个完整的教育观点","hookText":"不要只看分数","segmentIds":["1"],"riskFlags":[],"internalScore":80},{"topicId":"topic-2","title":"未完成',
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    const result = await adapter.analyze(
      { account, task: {} as never, transcript },
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.topicId).toBe("topic-1");
    vi.unstubAllGlobals();
  });

  it("retries once when the provider returns malformed JSON without a complete object", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        const body = JSON.stringify({
          id: `req-repair-${calls}`,
          model: config.model,
          choices: [{
            message: {
              content: calls === 1
                ? '{"candidates":[{"topicId":"topic-1","title":"未完成'
                : JSON.stringify({ candidates: [] }),
            },
          }],
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).resolves.toEqual([]);
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });

  it("retries when DeepSeek returns a segment id that is not in the current transcript", async () => {
    let calls = 0;
    let retrySystem = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as {
          messages?: Array<{ role: string; content: string }>;
        };
        retrySystem = body.messages?.[0]?.content ?? "";
        const candidate = {
          topicId: "topic-1",
          title: "一个完整的教育观点",
          hookText: "不要只看分数",
          segmentIds: [calls === 1 ? "analysis-not-in-input" : "1"],
          riskFlags: [],
          internalScore: 80,
        };
        return new Response(
          JSON.stringify({
            id: `req-id-repair-${calls}`,
            model: config.model,
            choices: [{ message: { content: JSON.stringify({ candidates: [candidate] }) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    const result = await adapter.analyze(
      { account, task: {} as never, transcript },
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.segmentIds).toEqual(["1"]);
    expect(calls).toBe(2);
    expect(retrySystem).toContain("只能复制本次 segments[].id");
    expect(retrySystem).toContain("analysis-not-in-input");
    vi.unstubAllGlobals();
  });

  it("does not return candidates when every model reference is unresolvable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "req-invalid-ids",
            model: config.model,
            choices: [{
              message: {
                content: JSON.stringify({
                  candidates: [{
                    topicId: "topic-1",
                    title: "一个完整的教育观点",
                    hookText: "不要只看分数",
                    segmentIds: ["analysis-not-in-input"],
                    riskFlags: [],
                    internalScore: 80,
                  }],
                }),
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).rejects.toThrow("引用的时间段编号与当前逐字稿不匹配");
    vi.unstubAllGlobals();
  });

  it("normalizes a string risk flag without dropping the whole response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "req-risk",
            model: config.model,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    candidates: [
                      {
                        topicId: "topic-1",
                        title: "一个完整的教育观点",
                        hookText: "不要只看分数",
                        segmentIds: ["1"],
                        riskFlags: ["需要核实事实"],
                        internalScore: 80,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const adapter = new DeepSeekModelAdapter(async () => config);
    const transcript: TranscriptSegment[] = [
      { id: "1", start: 0, end: 40, text: "这是一个完整的教育观点。", confidence: "source" },
    ];
    const result = await adapter.analyze(
      { account, task: {} as never, transcript },
      [],
    );
    expect(result[0]?.riskFlags[0]?.reason).toBe("需要核实事实");
    expect(result[0]?.riskFlags[0]?.type).toBe("context");
    vi.unstubAllGlobals();
  });

  it("limits concurrent long-transcript windows and preserves their source order", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return new Response(
          JSON.stringify({
            id: `req-window-${requestBodies.length}`,
            model: config.model,
            choices: [{ message: { content: '{"candidates":[]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const adapter = new DeepSeekModelAdapter(async () => config, {
      analysisConcurrency: 2,
      maxChapterChars: 10_000,
      maxChapterSeconds: 600,
      maxWindowChars: 4,
      maxWindowSeconds: 600,
      overlapSegments: 0,
      chapterBreakGapSeconds: 100,
    });
    const transcript: TranscriptSegment[] = Array.from({ length: 5 }, (_, index) => ({
      id: `window-${index + 1}`,
      start: index * 10,
      end: index * 10 + 5,
      text: "完整论证",
      confidence: "source",
    }));
    await expect(
      adapter.analyze({ account, task: {} as never, transcript }, []),
    ).resolves.toEqual([]);
    expect(requestBodies).toHaveLength(5);
    expect(maxActive).toBe(2);
    const windows = requestBodies.map((body) => {
      const user = JSON.parse(String((body.messages as Array<{ role: string; content: string }>).find((message) => message.role === "user")?.content));
      return user.windowIndex;
    });
    expect(windows).toEqual([1, 2, 3, 4, 5]);
    vi.unstubAllGlobals();
  });

  it("merges exact and semantically duplicated window results without changing distinct candidates", () => {
    const candidates = mergeModelCandidates([
      {
        topicId: "one",
        title: "家长如何根据分数选择补课",
        hookText: "补课不能只看数量，要看目标和反馈",
        segmentIds: ["a", "b"],
        riskFlags: [],
        internalScore: 90,
      },
      {
        topicId: "one-copy",
        title: "家长如何根据分数选择补课",
        hookText: "补课不能只看数量，要看目标和反馈",
        segmentIds: ["b", "a"],
        riskFlags: [],
        internalScore: 88,
      },
      {
        topicId: "two",
        title: "专业选择要同时看兴趣和就业",
        hookText: "专业不能只看排名，还要看就业方向",
        segmentIds: ["c", "d"],
        riskFlags: [],
        internalScore: 86,
      },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.topicId)).toEqual(["one", "two"]);
  });
});

 describe('injected model networking', () => {
  it('uses the supplied transport for text selection', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' } }] }), { headers: { 'content-type': 'application/json' } }));
    const model = new DeepSeekModelAdapter(async () => ({ apiKey: 'test', baseUrl: 'https://example.com/v1', model: 'test' }), { request });
    await expect(model.textSelection('test', {}, 'copy')).resolves.toEqual({ candidates: [] });
    expect(request).toHaveBeenCalledWith('https://example.com/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
  });
 });

describe('V4.1 Flash 官方模型名兼容', () => {
  it.each(['deepseek-flash', 'deepseek-v4-flash'])('模型 %s 保持分析思考参数与原有JSON读取', async (modelName) => {
    const request = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(modelName);
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('high');
      expect(body).not.toHaveProperty('temperature');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { headers: { 'content-type': 'application/json' } });
    });
    const adapter = new DeepSeekModelAdapter(async () => ({ apiKey: 'test', baseUrl: 'https://api.deepseek.com', model: modelName }), { request });
    await expect(adapter.textSelection('遵守原文边界', { rule: '只用本场原话' }, 'analysis')).resolves.toEqual({ ok: true });
  });
});

it('初选低强度思考参数能传到真实请求构造，身份不含凭据', async () => {
  const request = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const adapter = new DeepSeekModelAdapter(async () => ({ apiKey: 'secret-test-key', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-flash' }), { request });
  await expect(adapter.textSelection('初选', {}, 'analysis', 'low')).resolves.toEqual({ candidates: [] });
  expect(await adapter.getSelectionIdentity()).toEqual({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
});
