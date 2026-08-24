/** One key of an index. Ditto SDK 5.1 supports composite indexes, so an index
 *  has an ordered list of these rather than a single field. Order is
 *  significant to the query optimizer. */
export interface IndexField {
  /** Dot-separated path, e.g. `address.city`. Backticks already stripped. */
  name: string;
  /** ASC when true, DESC when false. */
  ascending: boolean;
}

export interface DittoIndex {
  /** Stored as "<collection>.<displayName>" by the SDK. */
  id: string;
  collection: string;
  /** Ordered keys. More than one means a composite index. */
  fields: IndexField[];
  /** "<id>" with the "<collection>." prefix removed. */
  displayName: string;
}

export interface DittoCollection {
  _id: string;
  name: string;
  documentCount?: number;
  indexes: DittoIndex[];
}
