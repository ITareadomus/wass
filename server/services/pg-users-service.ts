import pool, { query } from '../../shared/pg-db';
import bcrypt from 'bcrypt';

export interface User {
  id: number;
  username: string;
  password: string;
  role: string;
  adam_id?: number;
  created_at?: Date;
  updated_at?: Date;
}

export class PgUsersService {

  async ensureTable(): Promise<void> {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          adam_id INTEGER,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Ensure adam_id column exists (migration for existing tables)
      await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS adam_id INTEGER`);
      console.log('✅ PG: Tabella users verificata/creata');
    } catch (error) {
      console.error('❌ PG: Errore nella creazione tabella users:', error);
    }
  }

  async getAllUsers(): Promise<User[]> {
    try {
      // Include passwords for admin settings page
      const result = await query('SELECT id, username, password, role, adam_id, created_at, updated_at FROM users ORDER BY id');
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento users:', error);
      return [];
    }
  }

  async getUserById(id: number): Promise<User | null> {
    try {
      const result = await query('SELECT id, username, password, role, adam_id, created_at, updated_at FROM users WHERE id = $1', [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error(`❌ PG: Errore nel caricamento user ${id}:`, error);
      return null;
    }
  }

  async getUserByUsername(username: string): Promise<User | null> {
    try {
      const result = await query('SELECT id, username, password, role, adam_id, created_at, updated_at FROM users WHERE username = $1', [username]);
      return result.rows[0] || null;
    } catch (error) {
      console.error(`❌ PG: Errore nel caricamento user ${username}:`, error);
      return null;
    }
  }

  async createUser(username: string, password: string, role: string = 'user'): Promise<User | null> {
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await query(
        'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, password, role, created_at, updated_at',
        [username, hashedPassword, role]
      );
      console.log(`✅ PG: User ${username} creato`);
      return result.rows[0] || null;
    } catch (error) {
      console.error(`❌ PG: Errore nella creazione user ${username}:`, error);
      return null;
    }
  }

  async updateUser(id: number, updates: Partial<Pick<User, 'username' | 'password' | 'role'>>): Promise<User | null> {
    try {
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.username !== undefined) {
        setClauses.push(`username = $${paramIndex++}`);
        values.push(updates.username);
      }
      if (updates.password !== undefined) {
        const hashedPassword = await bcrypt.hash(updates.password, 10);
        setClauses.push(`password = $${paramIndex++}`);
        values.push(hashedPassword);
      }
      if (updates.role !== undefined) {
        setClauses.push(`role = $${paramIndex++}`);
        values.push(updates.role);
      }

      if (setClauses.length === 0) return null;

      setClauses.push(`updated_at = NOW()`);
      values.push(id);

      const result = await query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, password, role, created_at, updated_at`,
        values
      );
      console.log(`✅ PG: User ${id} aggiornato`);
      return result.rows[0] || null;
    } catch (error) {
      console.error(`❌ PG: Errore nell'aggiornamento user ${id}:`, error);
      return null;
    }
  }

  async deleteUser(id: number): Promise<boolean> {
    try {
      const result = await query('DELETE FROM users WHERE id = $1', [id]);
      if (result.rowCount && result.rowCount > 0) {
        console.log(`✅ PG: User ${id} eliminato`);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ PG: Errore nell'eliminazione user ${id}:`, error);
      return false;
    }
  }

  async validateLogin(username: string, password: string): Promise<User | null> {
    try {
      const result = await query(
        'SELECT id, username, password, role, created_at, updated_at FROM users WHERE username = $1',
        [username]
      );
      
      const user = result.rows[0];
      if (!user) return null;
      
      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) return null;
      
      return user;
    } catch (error) {
      console.error(`❌ PG: Errore nella validazione login:`, error);
      return null;
    }
  }

  async migrateFromJson(users: Array<{ id?: number; username: string; password: string; role: string }>): Promise<number> {
    let migrated = 0;
    for (const user of users) {
      const existing = await this.getUserByUsername(user.username);
      if (!existing) {
        await this.createUser(user.username, user.password, user.role);
        migrated++;
      }
    }
    console.log(`✅ PG: ${migrated} users migrati da JSON`);
    return migrated;
  }
}

export const pgUsersService = new PgUsersService();
