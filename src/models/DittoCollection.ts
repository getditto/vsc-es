export interface DittoIndex {
  /** Stored as "<collection>.<displayName>" by the SDK. */
  id: string;
  collection: string;
  /** Field names with backticks stripped. */
  fields: string[];
  /** "<id>" with the "<collection>." prefix removed. */
  displayName: string;
}

export interface DittoCollection {
  _id: string;
  name: string;
  documentCount?: number;
  indexes: DittoIndex[];
}
