'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { requestBrowserJson } from '@/lib/browser-api';
import { registerClientModelNames } from '@/lib/ai/model-name-cache';
import { useAppBootstrap } from '@/lib/hooks/useAppBootstrap';
import { queryKeys } from '@/lib/query/keys';
import type { AIVendor } from '@/types';
import type { MembershipType } from '@/lib/user/membership';

type AvailableModel = {
  id: string;
  name: string;
  vendor: AIVendor;
  supportsVision?: boolean; // 👈 补全类型定义
  supports_vision?: boolean;
  supportsReasoning: boolean;
  isReasoningDefault?: boolean;
  allowed?: boolean;
  blockedReason?: string | null;
  reasoningAllowed?: boolean;
};

async function loadAvailableModels() {
  const result = await requestBrowserJson<{ models?: AvailableModel[] }>('/api/models', {
    method: 'GET',
  });

  if (result.error) {
    throw new Error(result.error.message || '模型加载失败');
  }

  return result.data?.models ?? [];
}

export function useAvailableModels(userId?: string | null, options?: { vision?: boolean; enabled?: boolean; membershipType?: MembershipType | null }) {
  const enabled = options?.enabled ?? true;
  const vision = options?.vision ?? false;
  const bootstrap = useAppBootstrap({ enabled });
  const effectiveUserId = userId ?? bootstrap.data.viewerSummary?.userId ?? null;
  const effectiveMembershipType = options?.membershipType ?? bootstrap.data.membership?.type ?? 'free';

  const query = useQuery({
    queryKey: queryKeys.models(effectiveUserId, {
      vision,
      membershipType: effectiveMembershipType,
    }),
    queryFn: loadAvailableModels,
    enabled,
    staleTime: 10 * 60_000,
    select: (models) => (
      vision
        ? models.filter((model) => {
            // ✅ 优先检查接口下发的视觉支持标记
            if (model.supportsVision || model.supports_vision) return true;

            // ✅ 兜底兼容：匹配 google 供应商或 vendor 名称中带有 vl/vision 的模型
            const vendorStr = String(model.vendor || '').toLowerCase();
            const idStr = String(model.id || '').toLowerCase();
            return (
              vendorStr === 'google' ||
              vendorStr === 'gemini-vl' ||
              vendorStr === 'qwen-vl' ||
              idStr.includes('gemini') ||
              idStr.includes('vision') ||
              idStr.includes('vl')
            );
          })
        : models
    ),
  });

  useEffect(() => {
    if (query.data && query.data.length > 0) {
      registerClientModelNames(query.data);
    }
  }, [query.data]);

  return query;
}
