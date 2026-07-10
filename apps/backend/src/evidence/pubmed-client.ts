// v2 §9.4 — Resolves identifiers against PubMed's E-utilities API.
//
// This IS the "quality-gated source" restriction (§9.4 item 2) by construction: the
// only way an identifier passes is by resolving to a record indexed in PubMed/MEDLINE.
// Forums, blogs, and unindexed preprints have no PMID and cannot resolve here — there
// is no separate denylist to maintain.
//
// PMID and DOI both funnel through the same PubMed lookup: a DOI is resolved to its
// PMID via esearch (term=<doi>[doi]) and then follows the identical esummary path.
// A DOI that isn't PubMed-indexed is treated exactly like a fabricated PMID: REJECT.
//
// Network access is expected and approved here (§9.4: "requires outbound network
// access at review time"). Every call accepts an injectable fetch implementation so
// tests can mock the API deterministically — no live network in the test suite.

export type PublicationRecord = {
  pmid: string
  title: string
  journal: string
  year: number | null
  publicationTypes: string[]
  // §9.4.2 — verification cannot check whether a claim fairly represents its source;
  // that's the human's job, and the human can only do it against something. Title/
  // journal/year alone are not enough (a subtly wrong number in grounded_justification
  // reads exactly as confident as a correct one against bare metadata). The abstract is
  // what makes "does this claim match the source?" actually answerable in the approval
  // UI without the reviewer leaving the app. null when unavailable — see fetchAbstract.
  abstract: string | null
}

export type PubmedClientDeps = {
  fetchImpl?: typeof fetch
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
}

// Distinguishes "the request could not be completed" (timeout, DNS failure, 5xx) from
// "the request completed and the identifier does not exist" (empty result set).
// §9.4: "failure to verify is never permission to trust" — callers must never treat
// this the same as a clean not-found; both reject, but with a different, explicable reason.
export class PubmedNetworkError extends Error {}

// Treats an unset OR empty-string env var as "not configured" — docker-compose
// passes these through as `${VAR:-}` (empty string when the .env var is absent),
// which is not the same as absent from process.env.
function envOrUndefined(value: string | undefined): string | undefined {
  return value ? value : undefined
}

function resolveDeps(deps?: PubmedClientDeps) {
  return {
    fetchImpl: deps?.fetchImpl ?? fetch,
    baseUrl:
      deps?.baseUrl ?? envOrUndefined(process.env.NCBI_EUTILS_BASE_URL) ?? 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    apiKey: deps?.apiKey ?? envOrUndefined(process.env.NCBI_API_KEY),
    timeoutMs: deps?.timeoutMs ?? Number(envOrUndefined(process.env.NCBI_REQUEST_TIMEOUT_MS) ?? 10_000),
  }
}

async function getJson(url: string, deps: Required<Omit<PubmedClientDeps, 'apiKey'>> & { apiKey?: string }): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs)
  try {
    const res = await deps.fetchImpl(url, { signal: controller.signal })
    if (!res.ok) {
      throw new PubmedNetworkError(`PubMed API returned HTTP ${res.status}`)
    }
    return await res.json()
  } catch (err) {
    if (err instanceof PubmedNetworkError) throw err
    throw new PubmedNetworkError(err instanceof Error ? err.message : 'PubMed API request failed')
  } finally {
    clearTimeout(timeout)
  }
}

// Returns the PMID a DOI resolves to on PubMed, or null if it isn't PubMed-indexed
// under that DOI (treated as "not found" by the caller, NOT a network error).
export async function resolveDoiToPmid(doi: string, deps?: PubmedClientDeps): Promise<string | null> {
  const d = resolveDeps(deps)
  const params = new URLSearchParams({ db: 'pubmed', retmode: 'json', term: `${doi}[doi]` })
  if (d.apiKey) params.set('api_key', d.apiKey)
  const json = (await getJson(`${d.baseUrl}/esearch.fcgi?${params.toString()}`, d)) as {
    esearchresult?: { idlist?: string[] }
  }
  const pmid = json.esearchresult?.idlist?.[0]
  return pmid ?? null
}

type EsummaryResult = {
  result?: {
    uids?: string[]
    [pmid: string]: unknown
  }
}

type EsummaryDocSummary = {
  title?: string
  fulljournalname?: string
  source?: string
  pubdate?: string
  pubtype?: string[]
  error?: string
}

// Fetches the record's metadata, or null if the PMID does not exist in PubMed
// (a clean "not found" — the esummary call itself succeeded).
export async function fetchPublicationRecord(
  pmid: string,
  deps?: PubmedClientDeps
): Promise<PublicationRecord | null> {
  const d = resolveDeps(deps)
  const params = new URLSearchParams({ db: 'pubmed', retmode: 'json', id: pmid })
  if (d.apiKey) params.set('api_key', d.apiKey)
  const json = (await getJson(`${d.baseUrl}/esummary.fcgi?${params.toString()}`, d)) as EsummaryResult

  const uids = json.result?.uids ?? []
  if (!uids.includes(pmid)) return null

  const doc = json.result?.[pmid] as EsummaryDocSummary | undefined
  if (!doc || doc.error) return null

  const yearMatch = doc.pubdate?.match(/^\d{4}/)

  return {
    pmid,
    title: doc.title ?? '',
    journal: doc.fulljournalname ?? doc.source ?? '',
    year: yearMatch ? Number(yearMatch[0]) : null,
    publicationTypes: doc.pubtype ?? [],
    abstract: null,   // esummary doesn't carry abstracts; fetchAbstract() fills this in
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

// Fetches the abstract via efetch (rettype=abstract&retmode=xml), preserving
// structured-abstract section labels (OBJECTIVE/METHODS/RESULTS/CONCLUSION) when
// present, since those are exactly what lets a reviewer spot-check a specific claimed
// number against the section that actually reports it.
//
// Deliberately best-effort and NON-FATAL: a missing or unfetchable abstract does not
// block verification (the fraud checks — identifier resolves, type matches — don't
// depend on it). Its absence must be surfaced to the human, never silently treated as
// "nothing to check" (see EvidenceApprovalView, which shows a direct PubMed link when
// this returns null).
export async function fetchAbstract(pmid: string, deps?: PubmedClientDeps): Promise<string | null> {
  const d = resolveDeps(deps)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), d.timeoutMs)
  try {
    const params = new URLSearchParams({ db: 'pubmed', id: pmid, rettype: 'abstract', retmode: 'xml' })
    if (d.apiKey) params.set('api_key', d.apiKey)
    const res = await d.fetchImpl(`${d.baseUrl}/efetch.fcgi?${params.toString()}`, { signal: controller.signal })
    if (!res.ok) return null
    const xml = await res.text()

    const sections: string[] = []
    const tagPattern = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g
    let match: RegExpExecArray | null
    while ((match = tagPattern.exec(xml)) !== null) {
      const label = match[1].match(/Label="([^"]*)"/)?.[1]
      const text = decodeXmlEntities(match[2].replace(/<[^>]+>/g, ''))
      if (!text) continue
      sections.push(label ? `${label}: ${text}` : text)
    }
    return sections.length > 0 ? sections.join('\n\n') : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
