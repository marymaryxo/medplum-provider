// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Communication, Practitioner } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ThreadInbox } from '../../components/messages/ThreadInbox';
import classes from './MessagesPage.module.css';
import { formatSearchQuery, Operator } from '@medplum/core';
import type { SearchRequest } from '@medplum/core';
import { useEffect, useMemo } from 'react';
import { normalizeCommunicationSearch } from '../../utils/communication-search';
import { AdminInboxDashboard } from '../../components/messages/AdminInboxDashboard';
import { useMedplumProfile } from '@medplum/react';
import { getPortalMode } from '../../utils/portal-mode';
/**
 * Fetches
 * @returns A React component that displays all Threads/Topics.
 */
export function MessagesPage(): JSX.Element {
  const { messageId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const profile = useMedplumProfile();

  const currentSearch = useMemo(() => (location.search ? location.search.substring(1) : ''), [location.search]);
  const rawSearchParams = useMemo(() => new URLSearchParams(currentSearch), [currentSearch]);
  const readOnlyMode = rawSearchParams.get('readonly') === '1';
  const viewedProviderRef = rawSearchParams.get('provider') ?? undefined;
  const view = rawSearchParams.get('view');
  const isDashboardDelegatedView = readOnlyMode && view === 'dashboard';
  const isAdminUser = useMemo(() => isAdminProfile(profile) && getPortalMode() === 'admin', [profile]);
  const showDashboard = isAdminUser && !readOnlyMode && !messageId && view === 'dashboard';
  const communicationSearch = useMemo(() => {
    const params = new URLSearchParams(currentSearch);
    // UI-only params used for admin read-only mode; never send to FHIR search.
    params.delete('readonly');
    params.delete('provider');
    params.delete('view');
    return params.toString();
  }, [currentSearch]);

  const withReadOnlyParams = (searchQuery: string): string => {
    if (!readOnlyMode || !viewedProviderRef) {
      return searchQuery;
    }
    const params = new URLSearchParams(searchQuery.startsWith('?') ? searchQuery.substring(1) : searchQuery);
    params.set('readonly', '1');
    params.set('provider', viewedProviderRef);
    if (isDashboardDelegatedView) {
      params.set('view', 'dashboard');
    }
    return `?${params.toString()}`;
  };

  const { normalizedSearch, parsedSearch } = useMemo(
    () =>
      normalizeCommunicationSearch({
        search: communicationSearch,
      }),
    [communicationSearch]
  );

  useEffect(() => {
    if (showDashboard) {
      return;
    }
    const isDetailView = Boolean(messageId);
    if (!isDetailView && normalizedSearch !== communicationSearch) {
      let prefix = normalizedSearch ? `?${normalizedSearch}` : '';
      if (readOnlyMode && viewedProviderRef) {
        const params = new URLSearchParams(prefix.startsWith('?') ? prefix.substring(1) : prefix);
        params.set('readonly', '1');
        params.set('provider', viewedProviderRef);
        if (isDashboardDelegatedView) {
          params.set('view', 'dashboard');
        }
        prefix = `?${params.toString()}`;
      }
      navigate(`/Communication${prefix}`, { replace: true })?.catch(console.error);
    }
  }, [
    communicationSearch,
    messageId,
    navigate,
    normalizedSearch,
    readOnlyMode,
    viewedProviderRef,
    showDashboard,
    isDashboardDelegatedView,
  ]);

  const onChange = (search: SearchRequest): void => {
    navigate(`/Communication${withReadOnlyParams(formatSearchQuery(search))}`)?.catch(console.error);
  };

  const getThreadUri = (topic: Communication): string => {
    return `/Communication/${topic.id}${withReadOnlyParams(formatSearchQuery(parsedSearch))}`;
  };

  const buildStatusSearch = (value: Communication['status']): SearchRequest => {
    const otherFilters = parsedSearch.filters?.filter((f) => f.code !== 'status') || [];
    const newFilters = [...otherFilters, { code: 'status', operator: Operator.EQUALS, value }];
    return {
      ...parsedSearch,
      filters: newFilters,
      offset: 0,
    };
  };

  const inProgressUri = `/Communication${withReadOnlyParams(formatSearchQuery(buildStatusSearch('in-progress')))}`;
  const completedUri = `/Communication${withReadOnlyParams(formatSearchQuery(buildStatusSearch('completed')))}`;

  const onNew = (message: Communication): void => {
    navigate(getThreadUri(message))?.catch(console.error);
  };

  const handleSelectProvider = (providerRef: string): void => {
    const params = new URLSearchParams();
    params.set('status', 'in-progress');
    params.set('readonly', '1');
    params.set('provider', providerRef);
    params.set('view', 'dashboard');
    navigate(`/Communication?${params.toString()}`)?.catch(console.error);
  };

  return (
    <div className={classes.container}>
      {showDashboard ? (
        <AdminInboxDashboard onSelectProvider={handleSelectProvider} />
      ) : (
        <ThreadInbox
          threadId={messageId}
          query={formatSearchQuery(parsedSearch).substring(1)}
          showPatientSummary={true}
          readOnlyMode={readOnlyMode}
          viewedProviderRef={viewedProviderRef}
          onNew={onNew}
          getThreadUri={getThreadUri}
          onChange={onChange}
          inProgressUri={inProgressUri}
          completedUri={completedUri}
        />
      )}
    </div>
  );
}

function isAdminProfile(profile: Practitioner | { email?: string; username?: string; telecom?: { system?: string; value?: string }[] } | undefined): boolean {
  if (!profile) {
    return false;
  }
  const allowedEmails = new Set(['admin@example.com', 'myoo@fshealth.com']);
  const directEmail = extractEmail(profile);
  if (directEmail && allowedEmails.has(directEmail.toLowerCase())) {
    return true;
  }
  const practitioner = profile as Practitioner;
  const practitionerEmail = practitioner.telecom?.find((t) => t.system === 'email')?.value;
  return !!practitionerEmail && allowedEmails.has(practitionerEmail.toLowerCase());
}

function extractEmail(profile: { email?: string; username?: string }): string | undefined {
  const withEmail = profile as { email?: string; username?: string };
  return withEmail.email ?? withEmail.username;
}
