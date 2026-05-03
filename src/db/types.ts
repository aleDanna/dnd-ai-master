import { customType } from 'drizzle-orm/pg-core';

/** Postgres bytea ↔ Node Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
