/**
 * Core types for og-title package
 */

/**
 * Legal description components parsed from county index
 */
export interface LegalDescription {
  sections: string[];
  block?: string;
  /** Subdivision tracts like SE, W2, S2SW4, ALL, etc. */
  subdivisions: string[];
  survey?: string;
}

/**
 * Structured instrument record parsed from county index runsheet
 */
export interface InstrumentRecord {
  instrumentType: string;
  bookType?: string;
  book?: string;
  page?: string;
  instrumentNumber?: string;
  instrumentDate?: Date;
  filedDate?: Date;
  consideration?: string;
  grantors: string[];
  grantees: string[];
  legal: LegalDescription;
  relatedBookPage?: string;
  /** Raw text of the row for debugging */
  rawText: string;
}

/**
 * Unparsed row that couldn't be cleanly parsed
 */
export interface UnparsedRow {
  rawText: string;
  reason: string;
  lineNumber?: number;
}

/**
 * Result of parsing the runsheet PDF
 */
export interface RunsheetParseResult {
  parsed: InstrumentRecord[];
  unparsed: UnparsedRow[];
  parseRate: number;
  totalRows: number;
}

/**
 * How certain we are that an instrument intersects the target tract
 */
export type IntersectionConfidence = 'certain' | 'possible';

/**
 * Scoped instrument that may touch the target tract
 */
export interface ScopedInstrument extends InstrumentRecord {
  intersection: IntersectionConfidence;
  scopingReason: string;
}

/**
 * Classification of instrument types relevant to working interest chain
 */
export type InstrumentTypeFamily =
  | 'patent'
  | 'deed'
  | 'mineral-deed'
  | 'royalty-deed'
  | 'oil-gas-lease'
  | 'assignment'
  | 'release'
  | 'probate'
  | 'deed-of-trust'
  | 'unit-designation'
  | 'pooling'
  | 'other';

/**
 * Classified instrument with type family
 */
export interface ClassifiedInstrument extends ScopedInstrument {
  typeFamily: InstrumentTypeFamily;
}

/**
 * Working interest ownership entry
 */
export interface WorkingInterestEntry {
  ownerName: string;
  interest: number;
  depthFrom?: string;
  depthTo?: string;
}

/**
 * Chain assembly result
 */
export interface ChainAssembly {
  instruments: ClassifiedInstrument[];
  /** Gaps and ambiguities in the chain */
  gaps: string[];
  /** Computed working interest picture */
  workingInterest: WorkingInterestEntry[];
}

/**
 * Grade comparison result
 */
export interface GradeResult {
  matched: Array<{ owner: string; methodInterest: number; reportInterest: number; delta: number }>;
  missed: Array<{ owner: string; reportInterest: number }>;
  spurious: Array<{ owner: string; methodInterest: number }>;
  explanation: string[];
}

/**
 * Variance ledger entry tracking county-specific assumptions
 */
export interface VarianceLedgerEntry {
  assumption: string;
  category: 'index-format' | 'instrument-type-vocabulary' | 'survey-convention' | 'legal-description-pattern' | 'recording-practice';
  notes: string;
}
