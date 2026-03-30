/**
 * Supabase Client for RX OS
 *
 * Provides authenticated access to Supabase for:
 * - Engagement tracking
 * - Skill run logging
 * - Query governance logs
 * - User authentication
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'supabase' });

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qigwnxnrczaamdqjbblo.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Database types (generated from schema)
export interface Engagement {
    id: string;
    user_id: string | null;
    client: string;
    domain: string | null;
    domain_scope: string | null;
    branch: string;
    data_schema: string | null;
    skill_version: string;
    skill_repository: string;
    situation_md: string | null;
    status: 'created' | 'inventory_complete' | 'basecamp_complete' | 'active' | 'archived';
    local_path: string | null;
    created_at: string;
    updated_at: string;
}

export interface SkillRun {
    id: string;
    engagement_id: string;
    skill_name: string;
    started_at: string;
    completed_at: string | null;
    status: 'pending' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: number | null;
    artifacts: string[] | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
}

export interface QueryLog {
    id: string;
    engagement_id: string | null;
    skill_run_id: string | null;
    query_text: string;
    query_hash: string | null;
    classification: string | null;
    executed_at: string;
    duration_ms: number | null;
    rows_returned: number | null;
    was_blocked: boolean;
    block_reason: string | null;
}

export interface Database {
    public: {
        Tables: {
            engagements: {
                Row: Engagement;
                Insert: {
                    id?: string;
                    user_id?: string | null;
                    client: string;
                    domain?: string | null;
                    domain_scope?: string | null;
                    branch: string;
                    data_schema?: string | null;
                    skill_version: string;
                    skill_repository?: string;
                    situation_md?: string | null;
                    status?: 'created' | 'inventory_complete' | 'basecamp_complete' | 'active' | 'archived';
                    local_path?: string | null;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    user_id?: string | null;
                    client?: string;
                    domain?: string | null;
                    domain_scope?: string | null;
                    branch?: string;
                    data_schema?: string | null;
                    skill_version?: string;
                    skill_repository?: string;
                    situation_md?: string | null;
                    status?: 'created' | 'inventory_complete' | 'basecamp_complete' | 'active' | 'archived';
                    local_path?: string | null;
                    updated_at?: string;
                };
                Relationships: [];
            };
            skill_runs: {
                Row: SkillRun;
                Insert: {
                    id?: string;
                    engagement_id: string;
                    skill_name: string;
                    started_at?: string;
                    completed_at?: string | null;
                    status?: 'pending' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
                    input_tokens?: number | null;
                    output_tokens?: number | null;
                    cost_usd?: number | null;
                    artifacts?: string[] | null;
                    error_message?: string | null;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    skill_name?: string;
                    started_at?: string;
                    completed_at?: string | null;
                    status?: 'pending' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
                    input_tokens?: number | null;
                    output_tokens?: number | null;
                    cost_usd?: number | null;
                    artifacts?: string[] | null;
                    error_message?: string | null;
                    updated_at?: string;
                };
                Relationships: [];
            };
            query_logs: {
                Row: QueryLog;
                Insert: {
                    id?: string;
                    engagement_id?: string | null;
                    skill_run_id?: string | null;
                    query_text: string;
                    query_hash?: string | null;
                    classification?: string | null;
                    executed_at?: string;
                    duration_ms?: number | null;
                    rows_returned?: number | null;
                    was_blocked?: boolean;
                    block_reason?: string | null;
                };
                Update: {
                    engagement_id?: string | null;
                    skill_run_id?: string | null;
                    query_text?: string;
                    query_hash?: string | null;
                    classification?: string | null;
                    duration_ms?: number | null;
                    rows_returned?: number | null;
                    was_blocked?: boolean;
                    block_reason?: string | null;
                };
                Relationships: [];
            };
        };
        Views: {};
        Functions: {};
        Enums: {
            engagement_status: 'created' | 'inventory_complete' | 'basecamp_complete' | 'active' | 'archived';
            skill_run_status: 'pending' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
        };
        CompositeTypes: {};
    };
}

// Singleton clients
let anonClient: SupabaseClient | null = null;
let serviceClient: SupabaseClient | null = null;

/**
 * Get the anonymous Supabase client (for user-authenticated requests)
 */
export function getSupabaseClient(): SupabaseClient {
    if (!anonClient) {
        if (!SUPABASE_ANON_KEY) {
            throw new Error('SUPABASE_ANON_KEY not configured');
        }
        anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
            },
        });
        log.info({ url: SUPABASE_URL }, 'Supabase client initialized');
    }
    return anonClient;
}

/**
 * Get the service role client (for admin operations, bypasses RLS)
 */
export function getSupabaseAdmin(): SupabaseClient {
    if (!serviceClient) {
        if (!SUPABASE_SERVICE_KEY) {
            throw new Error('SUPABASE_SERVICE_KEY not configured');
        }
        serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
        log.info('Supabase admin client initialized');
    }
    return serviceClient;
}

/**
 * Check if Supabase is configured
 */
export function isSupabaseConfigured(): boolean {
    return !!(SUPABASE_URL && (SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY));
}

/**
 * Get the Supabase URL
 */
export function getSupabaseUrl(): string {
    return SUPABASE_URL;
}

// Export types
export type { SupabaseClient };
