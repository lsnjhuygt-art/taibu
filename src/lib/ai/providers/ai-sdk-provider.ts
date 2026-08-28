/**
 * AI SDK Provider 适配层
 *
 * 基于 Vercel AI SDK（ai v6 + @ai-sdk/openai v3）
 * 替换原有的 openai-compatible.ts / vision-provider.ts
 */

import { createOpenAI } from '@ai-sdk/openai';
// @ts-expect-error TS Cannot find module 'ai' due to Next.js 15 bundler resolution in CLI tsc
import { generateText, streamText, type CoreMessage, type LanguageModel, type ProviderOptions, type JSONValue } from 'ai';
import type { AIModelConfig } from '@/types';
import type { ChatMessage, AIReasoningEffort } from '@/types';
import { normalizeCustomProviderBaseUrl } from '@/lib/ai/custom-provider-url';

// AI 请求只需要最小消息结构，避免强制依赖存储/展示字段。
export type AIRequestMessage = Pick<ChatMessage, 'role' | 'content' | 'model' | 'reasoning'>;

export interface AIProviderOptions {
    temperature?: number;
    maxTokens?: number;
    reasoning?: boolean;
    reasoningEffort?: AIReasoningEffort;
    imageBase64?: string;
    imageMimeType?: string;
}

export function getApiKey(envVar: string): string | undefined {
    return process.env[envVar];
}

/**
 * 根据 AIModelConfig 动态创建 AI SDK provider 实例和模型
 */
export function createModelFromConfig(
    config: AIModelConfig,
    options?: { reasoning?: boolean },
): LanguageModel {
    const apiKey = getApiKey(config.apiKeyEnvVar);
    if (!apiKey || apiKey === 'your_api_key_here') {
        throw new Error(`${config.name || config.id} API key not configured (${config.apiKeyEnvVar})`);
    }

    const baseURL = normalizeBaseUrl(config.apiUrl);

    const provider = createOpenAI({
        apiKey,
        baseURL,
        fetch: gatewayFetch,
    });

    let modelId = (options?.reasoning && config.reasoningModelId)
        ? config.reasoningModelId
        : config.modelId;

    if (modelId === 'gemini-3.1-pro') {
        modelId = 'gemini-3.1-pro-preview';
    }

    return provider.chat(modelId);
}

/**
 * 检查模型配置是否可用
 */
export function isModelAvailable(config: AIModelConfig): boolean {
    const key = getApiKey(config.apiKeyEnvVar);
    return !!key && key !== 'your_api_key_here';
}

/**
 * 将 AIRequestMessage 转换为 AI SDK CoreMessage 格式
 */
export function toCoreMessages(
    messages: AIRequestMessage[],
    options?: { imageBase64?: string; imageMimeType?: string },
): CoreMessage[] {
    return messages.filter(msg => msg.role !== 'system').map((msg, index, filtered) => {
        if (
            msg.role === 'user' &&
            options?.imageBase64 &&
            index === filtered.length - 1
        ) {
            return {
                role: 'user' as const,
                content: [
                    {
                        type: 'image' as const,
                        image: `data:${options.imageMimeType || 'image/jpeg'};base64,${options.imageBase64}`,
                    },
                    {
                        type: 'text' as const,
                        text: msg.content,
                    },
                ],
            };
        }

        return {
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
        };
    });
}

const ENABLE_THINKING_VENDORS = new Set(['glm', 'deepseek', 'moonshot', 'qwen', 'qwen-vl']);

function buildThinkingParams(
    vendor: string,
    reasoning?: boolean,
): Record<string, JSONValue> {
    if (!reasoning) return {};
    if (ENABLE_THINKING_VENDORS.has(vendor)) {
        return { enable_thinking: true };
    }
    return {};
}

function buildProviderOptions(
    config: AIModelConfig,
    options?: AIProviderOptions,
): ProviderOptions | undefined {
    const providerOptions: Record<string, JSONValue> = {};

    if (options?.reasoning) {
        const effort = options.reasoningEffort ?? config.defaultReasoningEffort;
        if (config.reasoningEffortFormat === 'reasoning_effort' && effort) {
            providerOptions.reasoningEffort = effort;
        } else if (config.reasoningEffortFormat === 'reasoning_object' && effort) {
            providerOptions.reasoning = { effort };
        } else {
            Object.assign(providerOptions, buildThinkingParams(config.vendor, true));
        }
    }

    if (config.customParameters && typeof config.customParameters === 'object') {
        Object.assign(providerOptions, config.customParameters);
    }

    if (Object.keys(providerOptions).length === 0) return undefined;

    return { openai: providerOptions };
}

function isGoogleModel(config: AIModelConfig): boolean {
    return config.vendor === 'google' || 
           config.vendor === 'gemini' || 
           (typeof config.apiUrl === 'string' && config.apiUrl.includes('googleapis.com'));
}

/**
 * 非流式调用
 */
export async function callWithAISDK(
    model: LanguageModel,
    messages: CoreMessage[],
    systemPrompt: string,
    config: AIModelConfig,
    options?: AIProviderOptions,
): Promise<{ text: string; reasoning?: string }> {
    const isGoogle = isGoogleModel(config);

    const result = await generateText({
        model,
        system: systemPrompt,
        messages,
        maxRetries: 0,
        temperature: options?.temperature ?? config.defaultTemperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? config.defaultMaxTokens ?? undefined,
        topP: config.defaultTopP ?? undefined,
        presencePenalty: isGoogle ? undefined : (config.defaultPresencePenalty || undefined),
        frequencyPenalty: isGoogle ? undefined : (config.defaultFrequencyPenalty || undefined),
        providerOptions: buildProviderOptions(config, options),
    });

    return {
        text: result.text,
        reasoning: result.reasoningText ?? undefined,
    };
}

/**
 * 流式调用
 */
export function streamWithAISDK(
    model: LanguageModel,
    messages: CoreMessage[],
    systemPrompt: string,
    config: AIModelConfig,
    options?: AIProviderOptions,
) {
    const isGoogle = isGoogleModel(config);

    const result = streamText({
        model,
        system: systemPrompt,
        messages,
        maxRetries: 0,
        temperature: options?.temperature ?? config.defaultTemperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? config.defaultMaxTokens ?? undefined,
        topP: config.defaultTopP ?? undefined,
        presencePenalty: isGoogle ? undefined : (config.defaultPresencePenalty || undefined),
        frequencyPenalty: isGoogle ? undefined : (config.defaultFrequencyPenalty || undefined),
        providerOptions: buildProviderOptions(config, options),
    });

    return result;
}

// ─── Internal Helpers ───

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function normalizeGatewayHeaders(init?: RequestInit): Headers {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', BROWSER_UA);
    if (!headers.has('Accept')) {
        let isStream = true;
        try {
            if (typeof init?.body === 'string') {
                isStream = JSON.parse(init.body).stream !== false;
            }
        } catch { /* default to stream */ }
        headers.set('Accept', isStream ? 'text/event-stream' : 'application/json');
    }
    return headers;
}

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
    if (signals.length === 1) {
        return signals[0];
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(signals);
    }

    const controller = new AbortController();
    const abort = (reason?: unknown) => {
        if (!controller.signal.aborted) {
            controller.abort(reason);
        }
    };
    for (const signal of signals) {
        if (signal.aborted) {
            abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => abort(signal.reason), { once: true });
    }
    return controller.signal;
}

async function fetchWithGatewayHeaders(
    url: string | URL | Request,
    init?: RequestInit,
    timeoutMs?: number,
    connectTimeoutMs?: number,
): Promise<Response> {
    const headers = normalizeGatewayHeaders(init);
    const signalParts: AbortSignal[] = [];
    if (init?.signal) {
        signalParts.push(init.signal);
    }
    if (typeof timeoutMs === 'number' && typeof AbortSignal.timeout === 'function') {
        signalParts.push(AbortSignal.timeout(timeoutMs));
    }

    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectController: AbortController | null = null;
    if (typeof connectTimeoutMs === 'number') {
        connectController = new AbortController();
        connectTimer = setTimeout(() => {
            connectController?.abort(new Error('CONNECT_TIMEOUT'));
        }, connectTimeoutMs);
        connectTimer.unref?.();
        signalParts.push(connectController.signal);
    }

    try {
        return await globalThis.fetch(url, {
            ...init,
            headers,
            signal: signalParts.length > 0 ? mergeAbortSignals(signalParts) : undefined,
        });
    } catch (error) {
        if (connectController?.signal.aborted && connectController.signal.reason instanceof Error) {
            throw connectController.signal.reason;
        }
        throw error;
    } finally {
        if (connectTimer) {
            clearTimeout(connectTimer);
        }
    }
}

/**
 * 清洗发往 Google 接口的请求体，彻底剔除其不支持的 penalty 字段
 */
function sanitizeRequestBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
    if (typeof body !== 'string') return body;
    try {
        const json = JSON.parse(body);
        let modified = false;
        if ('frequency_penalty' in json) {
            delete json.frequency_penalty;
            modified = true;
        }
        if ('presence_penalty' in json) {
            delete json.presence_penalty;
            modified = true;
        }
        return modified ? JSON.stringify(json) : body;
    } catch {
        return body;
    }
}

function gatewayFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    let finalUrl: string | URL | Request = url;
    let finalInit: RequestInit | undefined = init;

    const urlStr = typeof url === 'string' 
        ? url 
        : (url instanceof URL ? url.href : (url instanceof Request ? url.url : ''));
    const isGoogle = urlStr.includes('googleapis.com');

    // 1. 深度拦截并修复发往 Google OpenAI 兼容端点时被 SDK 错误追加的 /v1
    if (typeof finalUrl === 'string') {
        finalUrl = finalUrl.replace('/v1beta/openai/v1/', '/v1beta/openai/');
    } else if (finalUrl instanceof URL) {
        finalUrl.pathname = finalUrl.pathname.replace('/v1beta/openai/v1/', '/v1beta/openai/');
    } else if (typeof Request !== 'undefined' && finalUrl instanceof Request) {
        if (finalUrl.url.includes('/v1beta/openai/v1/')) {
            const newUrl = finalUrl.url.replace('/v1beta/openai/v1/', '/v1beta/openai/');
            finalUrl = new Request(newUrl, finalUrl);
        }
    }

    // 2. 针对 Google 接口，直接在 HTTP 请求体层面强行剔除 frequency_penalty 和 presence_penalty
    if (isGoogle && finalInit?.body) {
        finalInit = {
            ...finalInit,
            body: sanitizeRequestBody(finalInit.body),
        };
    }

    return fetchWithGatewayHeaders(finalUrl, finalInit);
}

function normalizeBaseUrl(apiUrl: string): string {
    return normalizeCustomProviderBaseUrl(apiUrl);
}
