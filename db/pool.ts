import pg from 'pg';

export type Pool = pg.Pool;

// numeric (1700) -> JS number; int8 (20) -> number (bigserial ids stay far below 2^53).
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url: string, max = 6): Pool {
  return new pg.Pool({ connectionString: url, max });
}
