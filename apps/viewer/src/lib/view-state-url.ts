import { decodeViewState, encodeViewState, ViewStateError, type ViewStateV1 } from '@cosmolabe/control';
import { validateEventLinkState, type EventLinkState } from './event-link-state';
import { validateProfileLinkState, type ProfileLinkState } from './profile-link-state';
import { withCatalogLocation } from './catalog-nav';

export type ViewerViewState = ViewStateV1 & { events?: EventLinkState; profiles?: ProfileLinkState };

/** No scripts are accepted. The validated state is the entire URL API. */
export function requestedView(search: string): ViewerViewState | null {
  const text = new URLSearchParams(search).get('view');
  if (text === null) return null;
  const base = decodeViewState(text);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return { ...base, ...(raw.events === undefined ? {} : { events: validateEventLinkState(raw.events) }),
    ...(raw.profiles === undefined ? {} : { profiles: validateProfileLinkState(raw.profiles) }) };
}

export function viewLink(state: ViewerViewState, pageUrl: string): string {
  const url = new URL(pageUrl);
  // Allowlist, not inheritance: only `source` (a shared link can't resolve
  // its catalog without it) travels; deployment/debug/embed params stay behind.
  const sources = url.searchParams.getAll('source');
  url.search = '';
  for (const s of sources) url.searchParams.append('source', s);
  url.search = withCatalogLocation(url.search, state.catalog);
  const base = JSON.parse(encodeViewState(state)) as ViewStateV1;
  const payload = JSON.stringify({ ...base, ...(state.events ? { events: validateEventLinkState(state.events) } : {}),
    ...(state.profiles ? { profiles: validateProfileLinkState(state.profiles) } : {}) });
  if (payload.length > 8192) throw new ViewStateError('View link is too large; share fewer event searches or profiles.');
  url.searchParams.set('view', payload);
  if (url.href.length > 8192) throw new ViewStateError('View link is too large for an ordinary URL.');
  return url.href;
}
