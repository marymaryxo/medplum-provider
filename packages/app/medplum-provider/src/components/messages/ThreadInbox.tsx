// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Collapse,
  Flex,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ActionIcon,
  Divider,
  Button,
  Center,
  ThemeIcon,
  Menu,
  Skeleton,
  Box,
  Pagination,
  Group,
  UnstyledButton,
} from '@mantine/core';
import type { Attachment, Communication, Patient, Practitioner, Reference } from '@medplum/fhirtypes';
import { PatientSummary, ThreadChat, useMedplum, useResource } from '@medplum/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  IconMessageCircle,
  IconChevronDown,
  IconFolder,
  IconPlus,
} from '@tabler/icons-react';
import { getDisplayString, getReferenceString, parseSearchRequest } from '@medplum/core';
import { useMedplumProfile } from '@medplum/react';
import type { SearchRequest } from '@medplum/core';
import { ChatList } from './ChatList';
import { NewTopicDialog } from './NewTopicDialog';
import { ReassignThreadDialog } from './ReassignThreadDialog';
import { BulkReassignThreadsDialog } from './BulkReassignThreadsDialog';
import { SharedFilesDialog } from './SharedFilesDialog';
import { useThreadInbox } from '../../hooks/useThreadInbox';
import classes from './ThreadInbox.module.css';
import { useDisclosure } from '@mantine/hooks';
import { useMediaQuery } from '@mantine/hooks';
import { showErrorNotification } from '../../utils/notifications';
import { showNotification } from '@mantine/notifications';
import cx from 'clsx';
import { Link, useNavigate } from 'react-router';
import { getPortalMode } from '../../utils/portal-mode';

/**
 * ThreadInbox is a component that displays a list of threads and allows the user to select a thread to view.
 * @param query - The query to fetch all communications.
 * @param threadId - The id of the thread to select.
 * @param subject - The default subject when creating a new thread.
 * @param showPatientSummary - Whether to show the patient summary.
 * @param onNew - A function to handle a new thread.
 * @param getThreadUri - A function to build thread URIs.
 * @param onChange - A function to handle search changes.
 * @param inProgressUri - The URI for in-progress threads.
 * @param completedUri - The URI for completed threads.
 */

interface ThreadInboxProps {
  query: string;
  threadId: string | undefined;
  subject?: Reference<Patient> | Patient | undefined;
  showPatientSummary?: boolean | undefined;
  readOnlyMode?: boolean | undefined;
  viewedProviderRef?: string | undefined;
  onNew: (message: Communication) => void;
  getThreadUri: (topic: Communication) => string;
  onChange: (search: SearchRequest) => void;
  inProgressUri: string;
  completedUri: string;
}

export function ThreadInbox(props: ThreadInboxProps): JSX.Element {
  const {
    query,
    threadId,
    subject,
    showPatientSummary = false,
    readOnlyMode = false,
    viewedProviderRef,
    onNew,
    getThreadUri,
    onChange,
    inProgressUri,
    completedUri,
  } = props;

  const medplum = useMedplum();
  const navigate = useNavigate();
  const profile = useMedplumProfile();
  const isAdminUser = useMemo(
    () =>
      isAdminProfile(
        profile as { email?: string; username?: string; telecom?: { system?: string; value?: string }[] } | undefined
      ) && getPortalMode() === 'admin',
    [profile]
  );
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);
  const [reassignOpened, { open: openReassign, close: closeReassign }] = useDisclosure(false);
  const [bulkReassignOpened, { open: openBulkReassign, close: closeBulkReassign }] = useDisclosure(false);
  const [sharedFilesOpened, { open: openSharedFiles, close: closeSharedFiles }] = useDisclosure(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [ownershipLogExpanded, setOwnershipLogExpanded] = useState(false);
  const isMobile = useMediaQuery('(max-width: 900px)');
  const mobileThreadListHeightPx = 220;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  const currentSearch = useMemo(() => parseSearchRequest(`Communication?${query}`), [query]);

  const searchParams = useMemo(() => new URLSearchParams(query), [query]);
  const itemsPerPage = Number.parseInt(searchParams.get('_count') || '20', 10);
  const currentOffset = Number.parseInt(searchParams.get('_offset') || '0', 10);
  const currentPage = Math.floor(currentOffset / itemsPerPage) + 1;
  const status = (searchParams.get('status') as Communication['status']) || 'in-progress';
  const isArchivedTab = status === 'completed';

  const {
    loading,
    error,
    threadMessages,
    selectedThread,
    total,
    unreadThreadIds,
    userMarkedUnreadThreadIds,
    handleThreadStatusChange,
    handleMarkThreadAsUnread,
    addThreadMessage,
    refreshThreadMessages,
  } = useThreadInbox({
    query,
    threadId,
    recipientRefOverride: viewedProviderRef,
    readOnlyMode,
  });

  const totalPages = useMemo(() => {
    if (loading || total === undefined) {
      return 0;
    }
    return Math.max(1, Math.ceil(total / itemsPerPage));
  }, [loading, total, itemsPerPage]);

  useEffect(() => {
    if (error) {
      showErrorNotification(error);
    }
  }, [error]);

  // Keep pagination on a valid page when data shrinks (e.g. bulk actions/reassignments).
  // This uses server-reported total and preserves default Medplum pagination semantics.
  useEffect(() => {
    if (loading) {
      return;
    }
    if (total === undefined) {
      return;
    }
    if (threadMessages.length > 0) {
      return;
    }
    if (currentOffset <= 0) {
      return;
    }
    const lastValidOffset = total > 0 ? Math.floor((total - 1) / itemsPerPage) * itemsPerPage : 0;
    if (currentOffset === lastValidOffset) {
      return;
    }
    onChange({
      ...currentSearch,
      offset: lastValidOffset,
    });
  }, [loading, total, threadMessages.length, currentOffset, itemsPerPage, onChange, currentSearch]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [selectedThread?.id]);

  useEffect(() => {
    // Always collapse ownership history when opening/switching threads.
    setOwnershipLogExpanded(false);
  }, [selectedThread?.id]);

  const handleTopicStatusChangeWithErrorHandling = async (newStatus: Communication['status']): Promise<void> => {
    try {
      await handleThreadStatusChange(newStatus);
      await refreshThreadMessages();
    } catch (error) {
      showErrorNotification(error);
    }
  };

  const handleMoveToInbox = async (): Promise<void> => {
    try {
      await handleTopicStatusChangeWithErrorHandling('in-progress');
      await handleMarkThreadAsUnread();
      navigate(inProgressUri)?.catch(console.error);
    } catch (error) {
      showErrorNotification(error);
    }
  };

  const handleMarkThreadAsUnreadWithInboxBehavior = async (): Promise<void> => {
    try {
      const wasArchivedTab = isArchivedTab;
      const wasCompletedThread = selectedThread?.status === 'completed';
      // Be explicit: if user is in Archived on a completed thread, move it to Inbox first.
      if (wasArchivedTab && wasCompletedThread) {
        await handleTopicStatusChangeWithErrorHandling('in-progress');
      }
      await handleMarkThreadAsUnread();
      if (wasArchivedTab) {
        navigate(inProgressUri)?.catch(console.error);
      }
    } catch (error) {
      showErrorNotification(error);
    }
  };

  const handleNewTopicCompletion = (message: Communication): void => {
    addThreadMessage(message);
    onNew(message);
  };

  const profileRefStr = profile ? getReferenceString(profile) : undefined;
  const isReassignedAway =
    !!selectedThread &&
    !!profileRefStr &&
    !selectedThread.recipient?.some((r) => referenceMatches(r.reference, profileRefStr));

  const newPractitionerRef = isReassignedAway ? selectedThread?.recipient?.[0] : undefined;
  const newPractitioner = useResource(newPractitionerRef);
  const reassignedToName = newPractitioner
    ? getDisplayString(newPractitioner)
    : newPractitionerRef?.display || 'another provider';
  const selectedPatient = useResource(selectedThread?.subject as Reference<Patient> | undefined);
  const selectedPatientId = selectedPatient?.id ?? selectedThread?.subject?.reference?.split('/').pop();
  const selectedThreadLastMessage = useMemo(
    () => threadMessages.find(([parent]) => parent.id === selectedThread?.id)?.[1],
    [threadMessages, selectedThread?.id]
  );
  const isSelectedThreadReassignedToMe =
    !!selectedThread?.identifier?.some(
      (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
    ) &&
    !!profileRefStr &&
    !!selectedThread?.recipient?.some((r) => referenceMatches(r.reference, profileRefStr));
  const assignerResource = useResource(selectedThreadLastMessage?.sender);
  const assignerNameFromThreadState = selectedThread?.identifier?.find(
    (id) => id.system === 'https://medplum.com/thread-state/assigner-display'
  )?.value;
  const assignerName =
    assignerNameFromThreadState ||
    (assignerResource && getDisplayString(assignerResource)) ||
    selectedThreadLastMessage?.sender?.display ||
    'A provider';
  const selectedPatientName =
    (selectedPatient && getDisplayString(selectedPatient)) ||
    selectedThread?.subject?.display ||
    'Patient';
  const viewedProvider = useResource(viewedProviderRef ? ({ reference: viewedProviderRef } as Reference<Practitioner>) : undefined);
  const viewedProviderName =
    (viewedProvider && getDisplayString(viewedProvider)) ||
    viewedProviderRef?.split('/').pop() ||
    'Provider';
  const canReassignInThisView = isAdminUser && readOnlyMode && !!viewedProviderRef;
  const showStaticArchivedStatus = !canReassignInThisView && isReassignedAway;
  const canBulkSelect = canReassignInThisView && !isArchivedTab;
  const reassignmentReason = selectedThread?.identifier?.find(
    (id) => id.system === 'https://medplum.com/thread-state/reassign-reason'
  )?.value;
  const isSelectedThreadReassigned =
    !!selectedThread?.identifier?.some(
      (id) => id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you'
    ) ||
    !!selectedThreadLastMessage?.identifier?.some(
      (id) => id.system === 'https://medplum.com/thread-event' && id.value === 'reassigned-to-you'
    );
  const [ownershipLogEntries, setOwnershipLogEntries] = useState<OwnershipLogEntry[]>([]);
  const selectedThreadCount = selectedThreadIds.size;
  const selectedThreads = useMemo(
    () =>
      threadMessages
        .map(([thread]) => thread)
        .filter((thread): thread is Communication => !!thread.id && selectedThreadIds.has(thread.id)),
    [selectedThreadIds, threadMessages]
  );

  useEffect(() => {
    if (!canBulkSelect) {
      setSelectionMode(false);
      setSelectedThreadIds(new Set());
    }
  }, [canBulkSelect]);

  useEffect(() => {
    if (!selectionMode) {
      setSelectedThreadIds(new Set());
    }
  }, [selectionMode]);

  const handleToggleSelectionMode = (): void => {
    setSelectionMode((prev) => !prev);
  };

  const handleToggleThreadSelection = (threadId: string, checked: boolean): void => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return next;
    });
  };

  const handleToggleAllThreads = (checked: boolean): void => {
    if (!checked) {
      setSelectedThreadIds(new Set());
      return;
    }
    const next = new Set<string>();
    for (const [thread] of threadMessages) {
      if (thread.id) {
        next.add(thread.id);
      }
    }
    setSelectedThreadIds(next);
  };

  const reassignThread = useCallback(
    async (
      thread: Communication,
      providerRef: Reference<Practitioner>,
      displayName: string,
      reason: string | undefined,
      timestampBaseMs = Date.now()
    ): Promise<void> => {
      if (!profile || !profileRefStr) {
        throw new Error('No signed in profile');
      }
      const priorOwnerName = thread.recipient?.[0]?.display || thread.recipient?.[0]?.reference?.split('/').pop() || 'Unassigned';
      const patientName =
        (thread.subject && typeof thread.subject === 'object' && thread.subject.display) ||
        'Patient';
      const fromProviderName = getDisplayString(profile);
      const reassignmentMessage = `${fromProviderName} reassigned ${patientName}'s thread to you.`;
      const ownershipEventIso = new Date(timestampBaseMs).toISOString();
      // Keep at least 2s gap so ordering remains deterministic with second-level DB precision.
      const reassignmentEventIso = new Date(timestampBaseMs + 2000).toISOString();

      await medplum.updateResource({
        ...thread,
        recipient: [{ ...providerRef, display: displayName }],
        status: 'in-progress',
        identifier: [
          ...(thread.identifier ?? []).filter(
            (id) =>
              !(
                (id.system === 'https://medplum.com/thread-state' && id.value === 'reassigned-to-you') ||
                id.system === 'https://medplum.com/thread-state/assigner-display' ||
                id.system === 'https://medplum.com/thread-state/assigner-ref' ||
                id.system === 'https://medplum.com/thread-state/reassign-reason' ||
                id.system === 'https://medplum.com/thread-state/reassigned-at'
              )
          ),
          { system: 'https://medplum.com/thread-state', value: 'reassigned-to-you' },
          { system: 'https://medplum.com/thread-state/assigner-display', value: fromProviderName },
          ...(profileRefStr ? [{ system: 'https://medplum.com/thread-state/assigner-ref', value: profileRefStr }] : []),
          ...(reason ? [{ system: 'https://medplum.com/thread-state/reassign-reason', value: reason }] : []),
          { system: 'https://medplum.com/thread-state/reassigned-at', value: reassignmentEventIso },
        ],
      });
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'completed',
        sender: profileRefStr ? { reference: profileRefStr, display: fromProviderName } : undefined,
        partOf: [{ reference: `Communication/${thread.id}` }],
        identifier: [{ system: 'https://medplum.com/thread-event', value: 'ownership-change' }],
        payload: [
          {
            contentString: JSON.stringify({
              priorOwner: priorOwnerName,
              newOwner: displayName,
              actor: fromProviderName,
              timestamp: reassignmentEventIso,
              reason: reason ?? undefined,
            }),
          },
        ],
        sent: ownershipEventIso,
      });
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sender: profileRefStr ? { reference: profileRefStr, display: fromProviderName } : undefined,
        recipient: [{ reference: providerRef.reference, display: displayName }],
        partOf: [{ reference: `Communication/${thread.id}` }],
        identifier: [{ system: 'https://medplum.com/thread-event', value: 'reassigned-to-you' }],
        payload: [{ contentString: reassignmentMessage }],
        sent: reassignmentEventIso,
      });
    },
    [medplum, profile, profileRefStr]
  );

  const handleReassign = useCallback(
    async (providerRef: Reference<Practitioner>, displayName: string, reason?: string): Promise<void> => {
      if (!selectedThread || !profile || !profileRefStr) return;
      await reassignThread(selectedThread, providerRef, displayName, reason);
      showNotification({
        color: 'green',
        message: `Thread reassigned to ${displayName}. You can no longer reply.`,
      });
      await refreshThreadMessages();
      closeReassign();
    },
    [selectedThread, profile, profileRefStr, reassignThread, refreshThreadMessages, closeReassign]
  );

  const handleBulkReassign = useCallback(
    async (providerRef: Reference<Practitioner>, displayName: string, reason?: string): Promise<void> => {
      if (!profile || !profileRefStr) {
        return;
      }
      const failures: string[] = [];
      let successCount = 0;
      for (let i = 0; i < selectedThreads.length; i++) {
        const thread = selectedThreads[i];
        const threadLabel =
          thread.subject?.display ||
          thread.topic?.text ||
          `Thread ${thread.id ?? i + 1}`;
        try {
          await reassignThread(thread, providerRef, displayName, reason, Date.now() + i * 3000);
          successCount++;
        } catch (err) {
          failures.push(`${threadLabel}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      if (successCount > 0) {
        showNotification({
          color: 'green',
          message: `${successCount} threads reassigned to ${displayName}`,
        });
      }
      if (failures.length > 0) {
        showNotification({
          color: 'red',
          title: 'Failed to reassign some threads',
          message: (
            <Stack gap={2}>
              {failures.map((failure, index) => (
                <Text size="xs" key={index}>
                  {failure}
                </Text>
              ))}
            </Stack>
          ),
          autoClose: false,
        });
      }

      setSelectionMode(false);
      setSelectedThreadIds(new Set());
      await refreshThreadMessages();
      closeBulkReassign();
    },
    [closeBulkReassign, profile, profileRefStr, reassignThread, refreshThreadMessages, selectedThreads]
  );

  useEffect(() => {
    if (!selectedThread?.id) {
      setOwnershipLogEntries([]);
      return;
    }
    const loadOwnershipLogs = async (): Promise<void> => {
      const rows = await medplum.searchResources('Communication', {
        'part-of': `Communication/${selectedThread.id}`,
        _sort: '-sent',
        _count: '50',
      });
      const parsed = rows
        .filter((c) =>
          c.identifier?.some((id) => id.system === 'https://medplum.com/thread-event' && id.value === 'ownership-change')
        )
        .map((c) => {
          const payloadText = c.payload?.[0]?.contentString;
          if (!payloadText) {
            return undefined;
          }
          try {
            const parsedPayload = JSON.parse(payloadText) as OwnershipLogEntry;
            if (!parsedPayload.priorOwner || !parsedPayload.newOwner || !parsedPayload.actor) {
              return undefined;
            }
            return parsedPayload;
          } catch {
            return undefined;
          }
        })
        .filter((e): e is OwnershipLogEntry => !!e)
        .sort((a, b) => {
          const aMs = new Date(a.timestamp).getTime();
          const bMs = new Date(b.timestamp).getTime();
          return (Number.isNaN(bMs) ? 0 : bMs) - (Number.isNaN(aMs) ? 0 : aMs);
        });
      setOwnershipLogEntries(parsed);
    };
    loadOwnershipLogs().catch(console.error);
  }, [medplum, selectedThread?.id]);

  const skeletonTitleWidths = [80, 72, 68, 64];
  const skeletonSubtitleWidths = [85, 78, 70, 60];

  return (
    <>
      <div className={classes.container}>
        {readOnlyMode && (
          <Alert
            color="fshTeal"
            variant="light"
            m="md"
            mb={0}
            style={{ flexShrink: 0 }}
            styles={{ body: { overflow: 'visible', minHeight: 'auto' } }}
          >
            Viewing {viewedProviderName}&apos;s inbox · Reassign only
          </Alert>
        )}
        <Flex direction={isMobile ? 'column' : 'row'} h="100%" w="100%">
          {/* Left sidebar - Messages list */}
          <Flex
            direction="column"
            w={isMobile ? '100%' : 380}
            h={isMobile ? (selectedThread ? `${mobileThreadListHeightPx}px` : '100%') : '100%'}
            className={cx({ [classes.rightBorder]: !isMobile })}
          >
            <Paper h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
              <ScrollArea style={{ flex: 1 }} scrollbarSize={10} type="hover" scrollHideDelay={250}>
                <Flex h={64} align="center" justify="space-between" p="md">
                  <Group gap="xs" wrap="nowrap" align="center">
                    <Button
                      component={Link}
                      to={inProgressUri}
                      className={cx(classes.button, { [classes.selected]: status === 'in-progress' })}
                      h={32}
                      radius="xl"
                    >
                      Inbox
                    </Button>
                    <Button
                      component={Link}
                      to={completedUri}
                      className={cx(classes.button, { [classes.selected]: status === 'completed' })}
                      h={32}
                      radius="xl"
                    >
                      Archived
                    </Button>
                  </Group>
                  <Group gap="xs" wrap="nowrap" align="center">
                    {canBulkSelect && (
                      <Button
                        variant={selectionMode ? 'filled' : 'light'}
                        size="sm"
                        h={32}
                        radius="xl"
                        onClick={handleToggleSelectionMode}
                      >
                        {selectionMode ? 'Clear selection' : 'Select threads'}
                      </Button>
                    )}
                    {!readOnlyMode && (
                      <ActionIcon className={classes.newThreadButton} variant="filled" onClick={openModal}>
                        <IconPlus size={16} />
                      </ActionIcon>
                    )}
                  </Group>
                </Flex>
                <Divider />
                {loading ? (
                  <Stack gap="md" p="md">
                    {Array.from({ length: 10 }).map((_, index) => {
                      const titleWidth = skeletonTitleWidths[index % skeletonTitleWidths.length];
                      const subtitleWidth = skeletonSubtitleWidths[index % skeletonSubtitleWidths.length];
                      return (
                        <Flex key={index} gap="sm" align="flex-start">
                          <Skeleton height={40} width={40} radius="50%" />
                          <Box style={{ flex: 1 }}>
                            <Flex direction="column" gap="xs">
                              <Skeleton height={16} width={`${titleWidth}%`} />
                              <Skeleton height={14} width={`${subtitleWidth}%`} />
                            </Flex>
                          </Box>
                        </Flex>
                      );
                    })}
                  </Stack>
                ) : (
                  threadMessages.length > 0 && (
                    <ChatList
                      threads={threadMessages}
                      selectedCommunication={selectedThread}
                      getThreadUri={getThreadUri}
                      unreadThreadIds={unreadThreadIds}
                      currentProfileRefStr={readOnlyMode && viewedProviderRef ? viewedProviderRef : profileRefStr}
                      selectionMode={selectionMode}
                      selectedThreadIds={selectedThreadIds}
                      onToggleThread={handleToggleThreadSelection}
                      onToggleAll={handleToggleAllThreads}
                    />
                  )
                )}
                {threadMessages.length === 0 && !loading && <EmptyMessagesState />}
              </ScrollArea>
              {selectionMode && selectedThreadCount > 0 && (
                <Box
                  p="sm"
                  style={{
                    position: 'sticky',
                    bottom: 0,
                    borderTop: '1px solid var(--mantine-color-gray-3)',
                    background: 'var(--mantine-color-body)',
                    zIndex: 5,
                  }}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" fw={600}>
                      {selectedThreadCount} selected
                    </Text>
                    <Button size="sm" h={32} radius="xl" onClick={openBulkReassign}>
                      Reassign selected
                    </Button>
                  </Group>
                </Box>
              )}
              {!loading && total !== undefined && total > itemsPerPage && (
                <Box p="md">
                  <Center>
                    <Pagination
                      value={currentPage}
                      total={totalPages}
                      onChange={(page) => {
                        const offset = (page - 1) * itemsPerPage;
                        onChange({
                          ...currentSearch,
                          offset,
                        });
                      }}
                      size="sm"
                      siblings={1}
                      boundaries={1}
                    />
                  </Center>
                </Box>
              )}
            </Paper>
          </Flex>

          {selectedThread ? (
            <>
              {/* Main chat area */}
              <Flex
                direction="column"
                style={{ flex: 1, minHeight: 0 }}
                h={isMobile ? `calc(100% - ${mobileThreadListHeightPx}px)` : '100%'}
                className={cx({ [classes.rightBorder]: !isMobile })}
              >
                <Paper h="100%" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                  <Stack h="100%" gap={0} style={{ minHeight: 0 }}>
                    <Stack gap={isMobile ? 8 : 0} p="md">
                      <Flex h={isMobile ? 'auto' : 40} align="center" justify="space-between">
                        <Text fw={800} truncate fz="lg">
                          {selectedThread.topic?.text ?? 'Messages'}
                        </Text>

                        {!isMobile && (canReassignInThisView || !readOnlyMode) && (
                          <Group gap="xs" wrap="nowrap" justify="flex-end" align="center">
                            <Button
                              variant="light"
                              size="sm"
                              h={32}
                              radius="xl"
                              leftSection={<IconFolder size={16} />}
                              onClick={openSharedFiles}
                            >
                              Shared files
                            </Button>
                            {showStaticArchivedStatus ? (
                              <Box className={classes.archivedStatusPill}>Archived</Box>
                            ) : (
                              <Menu position="bottom-end" shadow="md">
                                <Menu.Target>
                                  <Button
                                    variant="light"
                                    size="sm"
                                    h={32}
                                    radius="xl"
                                    className={classes.headerStatusButton}
                                    rightSection={<IconChevronDown size={16} />}
                                  >
                                    {isArchivedTab ? 'Archived' : getStatusLabel(selectedThread.status)}
                                  </Button>
                                </Menu.Target>

                                <Menu.Dropdown>
                                  {canReassignInThisView ? (
                                    <Menu.Item onClick={openReassign}>
                                      Reassign thread
                                    </Menu.Item>
                                  ) : (
                                    <>
                                      {isArchivedTab && (
                                        <Menu.Item onClick={() => handleMoveToInbox()}>
                                          Move to inbox
                                        </Menu.Item>
                                      )}
                                      {!isArchivedTab && (
                                        <Menu.Item
                                          onClick={() => handleMarkThreadAsUnreadWithInboxBehavior()}
                                        >
                                          Mark as unread
                                        </Menu.Item>
                                      )}
                                      {!isArchivedTab && (
                                        <Menu.Item
                                          onClick={() => handleTopicStatusChangeWithErrorHandling('completed')}
                                        >
                                          Archive
                                        </Menu.Item>
                                      )}
                                    </>
                                  )}
                                </Menu.Dropdown>
                              </Menu>
                            )}
                          </Group>
                        )}
                      </Flex>

                      {isMobile && (canReassignInThisView || !readOnlyMode) && (
                        <Group gap="xs" grow wrap="nowrap" align="center">
                          <Button
                            variant="light"
                            size="sm"
                            h={32}
                            radius="xl"
                            leftSection={<IconFolder size={14} />}
                            onClick={openSharedFiles}
                          >
                            Shared files
                          </Button>
                          {showStaticArchivedStatus ? (
                            <Box className={classes.archivedStatusPill}>Archived</Box>
                          ) : (
                            <Menu position="bottom-end" shadow="md">
                              <Menu.Target>
                                <Button
                                  variant="light"
                                  size="sm"
                                  h={32}
                                  radius="xl"
                                  className={classes.headerStatusButton}
                                  rightSection={<IconChevronDown size={14} />}
                                >
                                  {isArchivedTab ? 'Archived' : getStatusLabel(selectedThread.status)}
                                </Button>
                              </Menu.Target>
                              <Menu.Dropdown>
                                {canReassignInThisView ? (
                                  <Menu.Item onClick={openReassign}>
                                    Reassign thread
                                  </Menu.Item>
                                ) : (
                                  <>
                                    {isArchivedTab && (
                                      <Menu.Item onClick={() => handleMoveToInbox()}>
                                        Move to inbox
                                      </Menu.Item>
                                    )}
                                    {!isArchivedTab && (
                                      <Menu.Item
                                        onClick={() => handleMarkThreadAsUnreadWithInboxBehavior()}
                                      >
                                        Mark as unread
                                      </Menu.Item>
                                    )}
                                    {!isArchivedTab && (
                                      <Menu.Item
                                        onClick={() => handleTopicStatusChangeWithErrorHandling('completed')}
                                      >
                                        Archive
                                      </Menu.Item>
                                    )}
                                  </>
                                )}
                              </Menu.Dropdown>
                            </Menu>
                          )}
                        </Group>
                      )}
                    </Stack>
                    <Divider />
                    {isReassignedAway && (
                      <Alert
                        variant="light"
                        m="md"
                        mb={0}
                        style={{ flexShrink: 0 }}
                        styles={{ body: { overflow: 'visible', minHeight: 'auto' } }}
                      >
                        <Text>Thread reassigned to {reassignedToName}. You can no longer reply.</Text>
                        {reassignmentReason && (
                          <Text size="xs" mt={4}>
                            Reason: {reassignmentReason}
                          </Text>
                        )}
                      </Alert>
                    )}
                    {!isReassignedAway && isSelectedThreadReassignedToMe && selectedThread.status === 'in-progress' && (
                      <Alert
                        variant="light"
                        m="md"
                        mb={0}
                        style={{ flexShrink: 0 }}
                        styles={{ body: { overflow: 'visible', minHeight: 'auto' } }}
                      >
                        <Text>{assignerName} reassigned {selectedPatientName}&apos;s thread to you.</Text>
                        {reassignmentReason && (
                          <Text size="xs" mt={4}>
                            Reason: {reassignmentReason}
                          </Text>
                        )}
                      </Alert>
                    )}
                    {isAdminUser && ownershipLogEntries.length > 0 && (
                      <Paper withBorder radius="md" m="md" mb={0} p="sm" style={{ flexShrink: 0 }}>
                        <UnstyledButton
                          onClick={() => setOwnershipLogExpanded((v) => !v)}
                          style={{ width: '100%' }}
                          aria-expanded={ownershipLogExpanded}
                          aria-label="Toggle ownership history"
                        >
                          <Group justify="space-between" wrap="nowrap">
                            <Text size="xs" fw={700} c="dimmed">
                              Ownership history · {ownershipLogEntries.length} transfers
                            </Text>
                            <IconChevronDown
                              size={14}
                              style={{
                                transform: ownershipLogExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 150ms ease',
                              }}
                            />
                          </Group>
                        </UnstyledButton>
                        <Collapse in={ownershipLogExpanded}>
                          <Stack gap={6} mt="xs">
                            {ownershipLogEntries.map((entry, index) => (
                              <Text size="xs" key={`${entry.timestamp}-${index}`}>
                                {formatOwnershipLogEntry(entry)}
                              </Text>
                            ))}
                          </Stack>
                        </Collapse>
                      </Paper>
                    )}
                    <Flex direction="column" style={{ flex: 1, minHeight: 0 }} h="100%">
                      <ThreadChat
                        title={'Messages'}
                        thread={selectedThread}
                        excludeHeader={true}
                        inputDisabled={isReassignedAway || readOnlyMode}
                        // @ts-expect-error hideInput is available in locally linked @medplum/react source.
                        hideInput={readOnlyMode || isReassignedAway}
                        attachments={pendingAttachments}
                        onAttachmentsChange={(attachments: Attachment[]) => setPendingAttachments(attachments)}
                        disableAutoMarkAsRead={
                          readOnlyMode || (selectedThread.id ? userMarkedUnreadThreadIds.has(selectedThread.id) : false)
                        }
                        onMessagesMarkedAsRead={refreshThreadMessages}
                      />
                    </Flex>
                  </Stack>
                </Paper>
              </Flex>

              {/* Right sidebar - Patient summary */}
              {selectedThread.subject && showPatientSummary && !isMobile && (
                <Flex direction="column" w={300} h="100%">
                  <ScrollArea p={0} h="100%" scrollbarSize={10} type="hover" scrollHideDelay={250}>
                    <PatientSummary
                      key={selectedThread.id}
                      patient={selectedThread.subject as Reference<Patient>}
                      onClickResource={() => {
                        if (!selectedPatientId) {
                          return;
                        }
                        navigate(`/Patient/${selectedPatientId}`)?.catch(console.error);
                      }}
                    />
                  </ScrollArea>
                </Flex>
              )}
            </>
          ) : (
            <Flex direction="column" style={{ flex: 1 }} h="100%">
              <NoMessages />
            </Flex>
          )}
        </Flex>
      </div>
      <NewTopicDialog subject={subject} opened={modalOpened} onClose={closeModal} onSubmit={handleNewTopicCompletion} />
      {canReassignInThisView && (
        <ReassignThreadDialog
          thread={selectedThread}
          opened={reassignOpened}
          onClose={closeReassign}
          onReassign={handleReassign}
        />
      )}
      {canReassignInThisView && (
        <BulkReassignThreadsDialog
          opened={bulkReassignOpened}
          threadCount={selectedThreadCount}
          fromProviderName={viewedProviderName}
          onClose={closeBulkReassign}
          onReassign={handleBulkReassign}
        />
      )}
      <SharedFilesDialog thread={selectedThread} opened={sharedFilesOpened} onClose={closeSharedFiles} />
    </>
  );
}

function NoMessages(): JSX.Element {
  return (
    <Center h="100%" w="100%">
      <Stack align="center" gap="md">
        <ThemeIcon size={64} variant="light" color="gray">
          <IconMessageCircle size={32} />
        </ThemeIcon>
        <Stack align="center" gap="xs">
          <Text size="sm" c="dimmed" ta="center">
            Select a message from the list to view details
          </Text>
        </Stack>
      </Stack>
    </Center>
  );
}

/** Returns user-facing label for thread status */
function getStatusLabel(status: Communication['status']): string {
  if (status === 'in-progress') return 'Inbox';
  if (status === 'completed') return 'Archived';
  if (status === 'stopped') return 'Stopped';
  return status?.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') ?? '';
}

function EmptyMessagesState(): JSX.Element {
  return (
    <Flex direction="column" h="100%" justify="center" align="center">
      <Stack align="center" gap="md" pt="xl">
        <IconMessageCircle size={64} color="var(--mantine-color-gray-4)" />
        <Text size="lg" c="dimmed" fw={500}>
          No messages found
        </Text>
      </Stack>
    </Flex>
  );
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

interface OwnershipLogEntry {
  priorOwner: string;
  newOwner: string;
  actor: string;
  timestamp: string;
  reason?: string;
}

function formatLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatOwnershipLogEntry(entry: OwnershipLogEntry): string {
  const priorOwner = formatOwnershipActor(entry.priorOwner);
  const newOwner = formatOwnershipActor(entry.newOwner);
  const formattedTimestamp = formatLogTimestamp(entry.timestamp);
  const base = `${formattedTimestamp} · ${priorOwner} → ${newOwner}`;
  return entry.reason?.trim() ? `${base} · Reason: ${entry.reason.trim()}` : base;
}

function formatOwnershipActor(value: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return 'Unknown provider';
  }
  const idCandidate = getUuidCandidate(trimmed);
  if (idCandidate) {
    return generateProviderAlias(idCandidate);
  }
  return trimmed;
}

function getUuidCandidate(value: string): string | undefined {
  const refMatch = value.match(/^Practitioner\/([0-9a-fA-F-]{36})$/);
  if (refMatch) {
    return refMatch[1];
  }
  const plainMatch = value.match(/^[0-9a-fA-F-]{36}$/);
  if (plainMatch) {
    return value;
  }
  return undefined;
}

function generateProviderAlias(seed: string): string {
  const firstNames = ['Avery', 'Jordan', 'Casey', 'Taylor', 'Riley', 'Morgan', 'Jamie', 'Alex'];
  const lastNames = ['Johnson', 'Lee', 'Patel', 'Rivera', 'Nguyen', 'Smith', 'Brown', 'Garcia'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const first = firstNames[hash % firstNames.length];
  const last = lastNames[(hash >>> 3) % lastNames.length];
  return `${first} ${last}`;
}

function isAdminProfile(
  profile: { email?: string; username?: string; telecom?: { system?: string; value?: string }[] } | undefined
): boolean {
  if (!profile) {
    return false;
  }
  const allowedEmails = new Set(['admin@example.com', 'myoo@fshealth.com']);
  const directEmail = profile.email ?? profile.username;
  if (directEmail && allowedEmails.has(directEmail.toLowerCase())) {
    return true;
  }
  const practitionerEmail = profile.telecom?.find((t) => t.system === 'email')?.value;
  return !!practitionerEmail && allowedEmails.has(practitionerEmail.toLowerCase());
}
