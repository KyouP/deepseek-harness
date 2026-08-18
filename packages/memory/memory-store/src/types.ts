/** One M2 episodic event card. Raw columns are immutable after insert. */
export interface Card {
  id: string
  summary: string
  content: string
  contextDesc: string | null
  keywords: string[]
  emotion: string | null
  salience: number
  strength: number
  pinned: boolean
  archived: boolean
  sessionId: string | null
  validFrom: string | null
  validTo: string | null
  recordedAt: string
}

/** Input for {@link MemoryStore.insertCard}. */
export interface NewCard {
  summary: string
  content: string
  contextDesc?: string | null
  keywords?: string[]
  emotion?: string | null
  salience?: number
  strength?: number
  pinned?: boolean
  sessionId?: string | null
  validFrom?: string | null
  validTo?: string | null
}

/** Derived-only patch allowed by the UPDATE whitelist. */
export interface DerivedCardPatch {
  strength?: number
  archived?: boolean
  contextDesc?: string | null
}

/** One M3 bi-temporal fact triple. */
export interface Fact {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number
  sourceCard: string | null
  supersededBy: string | null
  validFrom: string | null
  validTo: string | null
  recordedAt: string
  pinned: boolean
}

/** Input for {@link MemoryStore.insertFact}. */
export interface NewFact {
  subject: string
  predicate: string
  object: string
  confidence?: number
  sourceCard?: string | null
  validFrom?: string | null
  validTo?: string | null
  pinned?: boolean
}

/** One tracked commitment. */
export interface Commitment {
  id: string
  content: string
  promisee: string
  dueAt: string | null
  status: 'active' | 'done' | 'expired' | 'cancelled'
  createdAt: string
  closedAt: string | null
}

/** Input for {@link MemoryStore.addCommitment}. */
export interface NewCommitment {
  content: string
  promisee?: string
  dueAt?: string | null
}

/** One M1 core block row. */
export interface CoreBlock {
  name: 'persona' | 'human'
  text: string
  revision: number
}

/** One FTS search hit. */
export interface SearchHit {
  id: string
  summary: string
  /** bm25 rank, lower is more relevant. */
  rank: number
}

/** Counts reported by {@link MemoryStore.forgetCard}. */
export interface ForgetReport {
  cards: number
  facts: number
  links: number
}
