// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Communication } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { getReferenceString } from '@medplum/core';

const USER_MARKED_UNREAD_STORAGE_KEY = 'medplum-provider-userMarkedUnreadThreadIds';
const OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY = 'medplum-provider-openedReassignedThreadMarkers';

function getScopedStorageKey(baseKey: string, profileRefStr: string | undefined): string {
  return profileRefStr ? `${baseKey}:${profileRefStr}` : `${baseKey}:anonymous`;
}

function loadUserMarkedUnreadFromStorage(profileRefStr?: string): Set<string> {
  try {
    const stored = sessionStorage.getItem(getScopedStorageKey(USER_MARKED_UNREAD_STORAGE_KEY, profileRefStr));
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    // ignore parse errors
  }
  return new Set();
}

function saveUserMarkedUnreadToStorage(ids: Set<string>, profileRefStr?: string): void {
  try {
    sessionStorage.setItem(getScopedStorageKey(USER_MARKED_UNREAD_STORAGE_KEY, profileRefStr), JSON.stringify([...ids]));
  } catch {
    // ignore storage errors
  }
}

function loadOpenedReassignedFromStorage(profileRefStr?: string): Set<string> {
  try {
    const stored = localStorage.getItem(
      getScopedStorageKey(OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY, profileRefStr)
    );
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    // ignore parse errors
  }
  return new Set();
}

function saveOpenedReassignedToStorage(ids: Set<string>, profileRefStr?: string): void {
  try {
    localStorage.setItem(
      getScopedStorageKey(OPENED_REASSIGNED_THREAD_MARKERS_STORAGE_KEY, profileRefStr),
      JSON.stringify([...ids])
    );
  } catch {
    // ignore storage errors
  }
}

export interface UseThreadInboxOptions {
  query: string;
  threadId: string | undefined;
  /** Optional recipient reference used for delegated/read-only inbox views. */
  recipientRefOverride?: string;
  /** When true, do not mutate unread/read state while browsing. */
  readOnlyMode?: boolean;
}

export interface UseThreadInboxReturn {
  loading: boolean;
  error: Error | null;
  // Tuple: [Parent Thread, Last Message in Thread (optional)]
  threadMessages: [Communication, Communication | undefined][];
  selectedThread: Communication | undefined;
  total: number | undefined;
  /** Thread IDs that have unread messages (for the current user) */
  unreadThreadIds: Set<string>;
  /** Thread IDs the user explicitly marked as unread - disable auto-mark-as-read when viewing */
  userMarkedUnreadThreadIds: Set<string>;
  addThreadMessage: (message: Communication) => void;
  handleThreadStatusChange: (newStatus: Communication['status']) => Promise<void>;
  handleMarkThreadAsRead: () => Promise<void>;
  handleMarkThreadAsUnread: () => Promise<void>;
  refreshThreadMessages: () => Promise<void>;
}

/*
useThreadInbox is a hook that fetches all communications and returns the thread messages and selected thread.
All communications returned do not have a partOf field.
It also provides a function to update the status of the selected thread.

@param query - The query to fetch all communications.
@param threadId - The id of the thread to select.
@returns The thread messages and selected thread.
@returns A function to update the status of the selected thread.
*/
export function useThreadInbox({
  query,
  threadId,
  recipientRefOverride,
  readOnlyMode = false,
}: UseThreadInboxOptions): UseThreadInboxReturn {
  const medplum = useMedplum();
  const currentProfileRefStr = recipientRefOverride ?? getReferenceString(medplum.getProfile());
  const [loading, setLoading] = useState(true);
  const [threadMessages, setThreadMessages] = useState<[Communication, Communication | undefined][]>([]);
  const [selectedThread, setSelectedThread] = useState<Communication | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [unreadThreadIds, setUnreadThreadIds] = useState<Set<string>>(new Set());
  const [userMarkedUnreadThreadIds, setUserMarkedUnreadThreadIds] = useState<Set<string>>(() =>
    loadUserMarkedUnreadFromStorage(currentProfileRefStr)
  );
  const userMarkedUnreadRef = useRef<Set<string>>(loadUserMarkedUnreadFromStorage(currentProfileRefStr));
  userMarkedUnreadRef.current = userMarkedUnreadThreadIds;

  useEffect(() => {
    const next = loadUserMarkedUnreadFromStorage(currentProfileRefStr);
    userMarkedUnreadRef.current = next;
    setUserMarkedUnreadThreadIds(next);
  }, [currentProfileRefStr]);

  // Persist userMarkedUnreadThreadIds across page navigation (e.g. Messages -> Schedule -> Messages)
  useEffect(() => {
    saveUserMarkedUnreadToStorage(userMarkedUnreadThreadIds, currentProfileRefStr);
  }, [currentProfileRefStr, userMarkedUnreadThreadIds]);

  const fetchAllCommunications = useCallback(async (): Promise<void> => {
    const searchParams = new URLSearchParams(query);
    const requestedStatus = searchParams.get('status') as Communication['status'] | null;
    if (!searchParams.has('_sort')) {
      // Keep newest threads on top consistently across paginated fetches.
      // This is critical for reassigned threads to surface immediately.
      searchParams.append('_sort', '-_lastUpdated');
    }
    if (requestedStatus === 'completed') {
      // Done needs both truly completed threads and reassigned-away threads that stay in-progress for assignees.
      // Remove server-side status restriction and apply status logic client-side below.
      searchParams.delete('status');
    }
    const profile = medplum.getProfile();
    const profileRefStr = profile ? getReferenceString(profile) : undefined;
    const recipientForQuery = recipientRefOverride ?? profileRefStr;
    const shouldFilterByRecipient =
      !!recipientForQuery &&
      requestedStatus === 'in-progress';
    if (shouldFilterByRecipient) {
      // Inbox should only contain threads assigned to current provider.
      // Keep Done behavior aligned with provider experience (not recipient-filtered).
      searchParams.append('recipient', recipientForQuery);
    }
    searchParams.append('identifier:not', 'ai-message-topic');
    searchParams.append('part-of:missing', 'true');
    searchParams.append('_has:Communication:part-of:_id:not', 'null');

    const bundle = await medplum.search('Communication', searchParams.toString(), { cache: 'no-cache' });
    const parents =
      bundle.entry
        ?.map((entry) => entry.resource as Communication)
        .filter((r): r is Communication => r !== undefined) || [];

    setTotal(bundle.total);

    if (parents.length === 0) {
      setThreadMessages([]);
      setTotal(0);
      return;
    }

    const queryParts = parents.map((parent) => {
      const safeId = parent.id?.replace(/-/g, '') || '';
      const alias = `thread_${safeId}`;
      const ref = getReferenceString(parent);

      return `
          ${alias}: CommunicationList(
            part_of: "${ref}"
            _sort: "-sent"
            _count: 1
          ) {
            id
            meta {
              lastUpdated
            }
            partOf {
              reference
            }
            sender {
              display
              reference
            }
            recipient {
              display
              reference
            }
            identifier {
              system
              value
            }
            payload {
              contentString
            }
            sent
            status
          }
        `;
    });

    const fullQuery = `
        query {
          ${queryParts.join('\n')}
        }
      `;

    const response = await medplum.graphql(fullQuery);

    const threadsWithReplies: [Communication, Communication | undefined][] = parents.map((parent) => {
        const safeId = parent.id?.replace(/-/g, '') || '';
        const alias = `thread_${safeId}`;
        const childList = response.data[alias] as Communication[] | undefined;
        const lastMessage = childList && childList.length > 0 ? childList[0] : undefined;
        return [parent, lastMessage];
      });
    const effectiveProfileRefStr = recipientRefOverride ?? profileRefStr;
    const filteredThreads = requestedStatus
      ? threadsWithReplies.filter(([parent]) => {
          const isReassignedThread = !!parent.identifier?.some(
            (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
          );
          const assignerRefFromThreadState = parent.identifier?.find(
            (id) => id.system === 'https://medplum.com/thread-state/assigner-ref'
          )?.value;
          const assignedToEffectiveProfile =
            !!effectiveProfileRefStr &&
            !!parent.recipient?.some((r) => referenceMatches(r.reference, effectiveProfileRefStr));
          const reassignedByEffectiveProfile =
            !!effectiveProfileRefStr && isReassignedThread && referenceMatches(assignerRefFromThreadState, effectiveProfileRefStr);

          if (requestedStatus === 'in-progress') {
            // Inbox: only include threads currently assigned to the effective profile.
            return parent.status === 'in-progress' && assignedToEffectiveProfile;
          }
          if (requestedStatus === 'completed') {
            // Archived: include threads completed for this provider and threads this provider reassigned away.
            // This prevents cross-provider leakage in delegated admin views.
            const completedForEffectiveProfile = parent.status === 'completed' && assignedToEffectiveProfile;
            return completedForEffectiveProfile || reassignedByEffectiveProfile;
          }
          return parent.status === requestedStatus;
        })
      : threadsWithReplies;

    const openedReassignedThreadIds = loadOpenedReassignedFromStorage(effectiveProfileRefStr);
    const sortedThreads = [...filteredThreads].sort((a, b) => {
      const aReassignedPriority =
        requestedStatus === 'in-progress' &&
        isUnopenedReassignedArrivalThread(a, effectiveProfileRefStr, openedReassignedThreadIds)
          ? 1
          : 0;
      const bReassignedPriority =
        requestedStatus === 'in-progress' &&
        isUnopenedReassignedArrivalThread(b, effectiveProfileRefStr, openedReassignedThreadIds)
          ? 1
          : 0;
      if (aReassignedPriority !== bReassignedPriority) {
        return bReassignedPriority - aReassignedPriority;
      }
      if (aReassignedPriority === 1 && bReassignedPriority === 1) {
        const aReassignedAt = getReassignedAtMs(a[0]);
        const bReassignedAt = getReassignedAtMs(b[0]);
        if (aReassignedAt !== bReassignedAt) {
          return bReassignedAt - aReassignedAt;
        }
      }
      const aTime = getThreadSortTimeMs(a);
      const bTime = getThreadSortTimeMs(b);
      return bTime - aTime;
    });

    setThreadMessages(sortedThreads);

    if (recipientForQuery) {
      const unreadParams = new URLSearchParams();
      unreadParams.append('recipient', recipientForQuery);
      unreadParams.append('sender:not', recipientForQuery);
      unreadParams.append('part-of:missing', 'false');
      unreadParams.append('_count', '500');
      const unreadBundle = await medplum.search('Communication', unreadParams.toString(), { cache: 'no-cache' });
      const ids = new Set<string>();
      for (const entry of unreadBundle.entry ?? []) {
        const c = entry.resource as Communication | undefined;
        if (!c || c.received) {
          continue;
        }
        const partOf = c?.partOf?.[0]?.reference;
        if (partOf?.startsWith('Communication/')) {
          ids.add(partOf.replace('Communication/', ''));
        }
      }
      // Always include threads user explicitly marked as unread (e.g. provider sent all, no messages to "unread").
      // In delegated admin view, include the provider-scoped stored unread markers so unread state mirrors provider inbox.
      if (!readOnlyMode || !!recipientRefOverride) {
        for (const id of userMarkedUnreadRef.current) {
          ids.add(id);
        }
      }
      // Guarantee reassigned arrival threads appear unread for assignee
      // until the assignee opens them once.
      for (const thread of sortedThreads) {
        if (!isUnopenedReassignedArrivalThread(thread, effectiveProfileRefStr, openedReassignedThreadIds)) {
          continue;
        }
        ids.add(thread[0].id as string);
      }
      // If unread messages arrive on a Done thread, move parent thread back to Inbox.
      if (!readOnlyMode) {
        const parentsToReopen = parents.filter((p) => p.id && p.status === 'completed' && ids.has(p.id));
        if (parentsToReopen.length > 0) {
          await Promise.all(
            parentsToReopen.map((parent) =>
              medplum.updateResource({
                ...parent,
                status: 'in-progress',
              })
            )
          );
          await fetchAllCommunications();
          return;
        }
      }
      setUnreadThreadIds(ids);
    }
  }, [medplum, query, recipientRefOverride, readOnlyMode, threadId]);

  useEffect(() => {
    setLoading(true);
    fetchAllCommunications()
      .catch((err: Error) => {
        setError(err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [fetchAllCommunications]);

  // When user OPENS a thread (navigates to it), remove from userMarkedUnreadThreadIds so it will
  // become read when they view. Do NOT remove when leaving - thread stays unread until reopened.
  const prevThreadIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const shouldHandleOpenAsRead = !readOnlyMode || !!recipientRefOverride;
    if (!shouldHandleOpenAsRead) {
      return;
    }
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = threadId;
    if (threadId && prevId !== threadId) {
      const openedThread = threadMessages.find(([parent]) => parent.id === threadId);
      if (
        !readOnlyMode &&
        openedThread &&
        isUnopenedReassignedArrivalThread(
          openedThread,
          currentProfileRefStr,
          loadOpenedReassignedFromStorage(currentProfileRefStr)
        )
      ) {
        const opened = loadOpenedReassignedFromStorage(currentProfileRefStr);
        opened.add(getReassignmentOpenMarker(openedThread[0]));
        saveOpenedReassignedToStorage(opened, currentProfileRefStr);
      }
      // User is opening this thread - remove so it will become read when they view
      if (!readOnlyMode) {
        setUserMarkedUnreadThreadIds((prev) => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
      // Optimistic: immediately show as read in list (don't wait for API)
      if (!readOnlyMode) {
        setUnreadThreadIds((prev) => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
    }
  }, [medplum, threadId, readOnlyMode, recipientRefOverride, threadMessages]);

  useEffect(() => {
    const fetchThread = async (): Promise<void> => {
      if (threadId) {
        const thread = threadMessages.find((t) => t[0].id === threadId);
        if (thread) {
          setSelectedThread(thread[0]);
        } else {
          try {
            const communication: Communication = await medplum.readResource('Communication', threadId);

            if (communication.partOf === undefined) {
              setSelectedThread(communication);
            } else {
              const parentRef = communication.partOf[0].reference;
              if (parentRef) {
                const parent = await medplum.readReference({ reference: parentRef } as any);
                setSelectedThread(parent as Communication);
              }
            }
          } catch (err) {
            setError(err as Error);
          }
        }
      } else {
        setSelectedThread(undefined);
      }
    };

    fetchThread().catch((err) => {
      setError(err as Error);
    });
  }, [threadId, threadMessages, medplum]);

  const handleThreadStatusChange = async (newStatus: Communication['status']): Promise<void> => {
    if (!selectedThread) {
      return;
    }
    try {
      const updatedThread = await medplum.updateResource({
        ...selectedThread,
        status: newStatus,
      });

      setSelectedThread(updatedThread);
      setThreadMessages((prev) =>
        prev.map(([parent, lastMsg]) => (parent.id === updatedThread.id ? [updatedThread, lastMsg] : [parent, lastMsg]))
      );
    } catch (err) {
      setError(err as Error);
    }
  };

  const addThreadMessage = async (message: Communication): Promise<void> => {
    await fetchAllCommunications();
    setThreadMessages((prev) => [[message, undefined], ...prev]);
  };

  const handleMarkThreadAsRead = async (): Promise<void> => {
    if (!selectedThread?.id) return;
    const profile = medplum.getProfile();
    const profileRefStr = profile ? getReferenceString(profile) : undefined;
    if (!profileRefStr) return;
    const searchParams = new URLSearchParams();
    searchParams.append('part-of', `Communication/${selectedThread.id}`);
    searchParams.append('recipient', profileRefStr);
    const bundle = await medplum.search('Communication', searchParams.toString(), { cache: 'no-cache' });
    const unread = (bundle.entry ?? [])
      .map((e) => e.resource as Communication)
      .filter((c): c is Communication => !!c?.id && !c.received);
    const now = new Date().toISOString();
    await Promise.all(
      unread.map((c) =>
        medplum.updateResource({
          ...c,
          received: c.received ?? now,
        })
      )
    );
    setUserMarkedUnreadThreadIds((prev) => {
      const next = new Set(prev);
      next.delete(selectedThread.id!);
      return next;
    });
    await fetchAllCommunications();
  };

  const handleMarkThreadAsUnread = async (): Promise<void> => {
    if (!selectedThread?.id) return;
    const threadIdToMark = selectedThread.id!;
    // If thread is archived, move it back to Inbox before marking unread.
    if (selectedThread.status === 'completed') {
      try {
        const updatedThread = await medplum.updateResource({
          ...selectedThread,
          status: 'in-progress',
        });
        setSelectedThread(updatedThread);
        setThreadMessages((prev) =>
          prev.map(([parent, lastMsg]) => (parent.id === updatedThread.id ? [updatedThread, lastMsg] : [parent, lastMsg]))
        );
      } catch (err) {
        setError(err as Error);
        return;
      }
    }
    // Optimistic update: show unread styling immediately
    setUnreadThreadIds((prev) => new Set(prev).add(threadIdToMark));
    setUserMarkedUnreadThreadIds((prev) => {
      const next = new Set(prev).add(threadIdToMark);
      userMarkedUnreadRef.current = next; // Update ref immediately so fetchAllCommunications sees it
      return next;
    });
    await fetchAllCommunications();
  };

  return {
    loading,
    error,
    threadMessages,
    selectedThread,
    total,
    unreadThreadIds,
    userMarkedUnreadThreadIds,
    addThreadMessage,
    handleThreadStatusChange,
    handleMarkThreadAsRead,
    handleMarkThreadAsUnread,
    refreshThreadMessages: fetchAllCommunications,
  };
}

function getThreadSortTimeMs([parent, lastMessage]: [Communication, Communication | undefined]): number {
  const candidates = [
    lastMessage?.sent,
    lastMessage?.meta?.lastUpdated,
    parent.meta?.lastUpdated,
    parent.sent,
  ];
  let maxMs = 0;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const ms = new Date(candidate).getTime();
    if (!Number.isNaN(ms) && ms > maxMs) {
      maxMs = ms;
    }
  }
  return maxMs;
}

function isUnopenedReassignedArrivalThread(
  [parent]: [Communication, Communication | undefined],
  effectiveProfileRefStr: string | undefined,
  openedReassignedThreadMarkers: Set<string>
): boolean {
  if (!parent.id || !effectiveProfileRefStr) {
    return false;
  }
  const hasReassignedMarker = !!parent.identifier?.some(
    (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
  );
  if (!hasReassignedMarker) {
    return false;
  }
  if (parent.status !== 'in-progress') {
    return false;
  }
  const marker = getReassignmentOpenMarker(parent);
  if (openedReassignedThreadMarkers.has(marker)) {
    return false;
  }
  const assignedToEffectiveProfile = !!parent.recipient?.some((r) => referenceMatches(r.reference, effectiveProfileRefStr));
  return assignedToEffectiveProfile;
}

function getReassignmentOpenMarker(parent: Communication): string {
  const reassignedAt = parent.identifier?.find((id) => id.system === 'https://medplum.com/thread-state/reassigned-at')?.value;
  return reassignedAt ? `${parent.id}:${reassignedAt}` : (parent.id as string);
}

function getReassignedAtMs(parent: Communication): number {
  const reassignedAt = parent.identifier?.find((id) => id.system === 'https://medplum.com/thread-state/reassigned-at')
    ?.value;
  if (!reassignedAt) {
    return 0;
  }
  const ms = new Date(reassignedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function referenceMatches(refStr: string | undefined, otherRefStr: string | undefined): boolean {
  if (!refStr || !otherRefStr) {
    return false;
  }
  const normalize = (s: string): string => {
    const parts = s.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : s;
  };
  return normalize(refStr) === normalize(otherRefStr);
}

