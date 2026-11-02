"use client";

/**
 * Live storage usage for the signed-in user: re-measured from Storage on mount/focus and after every delete
 * (`invalidate`), never cached as a counter. The chosen limit is read from localStorage and follows changes made in
 * this tab or another.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { db, storage } from "@/lib/firebase/client";
import { useAuthStore } from "@/store/auth-store";
import { loadStorageLimit, saveStorageLimit, STORAGE_LIMIT_CHANGED_EVENT, storageLimitKey } from "../lib/storage-limit";
import { discoverStorageFiles, type StorageDiscovery } from "../lib/storage-service";
import { summarizeStorage } from "../lib/storage-usage";

export function storageUsageQueryKey(uid: string | undefined) {
  return ["storageUsage", uid] as const;
}

export function useStorageLimit() {
  const uid = useAuthStore((s) => s.user?.uid);
  const [limitBytes, setLimitBytes] = useState(() => loadStorageLimit(uid));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reload the stored limit when the signed-in user changes
    setLimitBytes(loadStorageLimit(uid));
    if (!uid) return;
    const reload = () => setLimitBytes(loadStorageLimit(uid));
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === uid) reload();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageLimitKey(uid)) reload();
    };
    window.addEventListener(STORAGE_LIMIT_CHANGED_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STORAGE_LIMIT_CHANGED_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [uid]);

  const setLimit = useCallback(
    (bytes: number) => {
      if (uid) saveStorageLimit(uid, bytes);
    },
    [uid],
  );
  return { limitBytes, setLimit };
}

export function useStorageUsage() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { limitBytes, setLimit } = useStorageLimit();

  const query = useQuery<StorageDiscovery>({
    queryKey: storageUsageQueryKey(uid),
    enabled: !!uid,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: () => discoverStorageFiles({ db, storage }, uid!),
  });

  const summary = useMemo(() => summarizeStorage(query.data?.files ?? [], limitBytes), [query.data, limitBytes]);
  const invalidate = useCallback(() => queryClient.invalidateQueries({ queryKey: storageUsageQueryKey(uid) }), [queryClient, uid]);

  return {
    uid,
    discovery: query.data,
    files: query.data?.files ?? [],
    summary,
    limitBytes,
    setLimit,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    refresh: invalidate,
  };
}
