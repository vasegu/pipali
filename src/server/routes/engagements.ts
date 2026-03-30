/**
 * Engagements API Routes
 *
 * Handles engagement creation, management, and skill execution.
 * Uses Supabase for persistent storage and auth.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createChildLogger } from '../logger';
import {
    getSupabaseAdmin,
    isSupabaseConfigured,
    type Engagement,
    type SkillRun,
} from '../supabase';
import {
    syncSkillRepository,
    createEngagementDirectory,
    copySkillsToEngagement,
    getSkillVersion,
    listSkillVersions,
} from '../engagements/skill-fetcher';
import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const log = createChildLogger({ component: 'engagements' });

const engagements = new Hono();

// Middleware to check Supabase is configured
engagements.use('*', async (c, next) => {
    if (!isSupabaseConfigured()) {
        return c.json({ error: 'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.' }, 503);
    }
    await next();
});

// Schema for creating a new engagement
const createEngagementSchema = z.object({
    client: z.string().min(1).max(100),
    domain: z.string().optional(),
    domainScope: z.string().optional(),
    branch: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Branch must be lowercase alphanumeric with hyphens'),
    dataSchema: z.string().optional(), // Supabase schema for engagement data
    situationMd: z.string().optional(),
    skillRepository: z.string().default('vasegu/rx-skills'),
    skillBranch: z.string().default('main'),
});

// List all engagements
engagements.get('/', async (c) => {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
        .from('engagements')
        .select('*')
        .order('updated_at', { ascending: false });

    if (error) {
        log.error({ error }, 'Failed to list engagements');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ engagements: data });
});

// Get a specific engagement
engagements.get('/:id', async (c) => {
    const id = c.req.param('id');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
        .from('engagements')
        .select('*')
        .eq('id', id)
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            return c.json({ error: 'Engagement not found' }, 404);
        }
        log.error({ error }, 'Failed to get engagement');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ engagement: data });
});

// Create a new engagement
engagements.post('/', zValidator('json', createEngagementSchema), async (c) => {
    const input = c.req.valid('json');

    log.info({ client: input.client, branch: input.branch }, 'Creating new engagement');

    try {
        // Create the engagement directory with skills
        const { path: engagementPath, version } = await createEngagementDirectory(input.branch, {
            repository: input.skillRepository,
            branch: input.skillBranch,
        });

        // Write SITUATION.md if provided
        if (input.situationMd) {
            const situationPath = join(engagementPath, 'SITUATION.md');
            await writeFile(situationPath, input.situationMd, 'utf-8');
            log.info({ path: situationPath }, 'Wrote SITUATION.md');
        }

        // Create engagement record in Supabase
        const supabase = getSupabaseAdmin();

        const { data: engagement, error } = await supabase
            .from('engagements')
            .insert({
                client: input.client,
                domain: input.domain || null,
                domain_scope: input.domainScope || null,
                branch: input.branch,
                data_schema: input.dataSchema || null,
                skill_version: version,
                skill_repository: input.skillRepository,
                situation_md: input.situationMd || null,
                local_path: engagementPath,
                status: 'created',
            })
            .select()
            .single();

        if (error) {
            log.error({ error }, 'Failed to create engagement in Supabase');
            return c.json({ error: error.message }, 500);
        }

        log.info({ id: engagement.id, branch: input.branch, version }, 'Engagement created');

        return c.json({ engagement }, 201);
    } catch (error) {
        log.error({ error }, 'Failed to create engagement');
        return c.json({
            error: error instanceof Error ? error.message : 'Failed to create engagement'
        }, 500);
    }
});

// Update engagement status
const updateStatusSchema = z.object({
    status: z.enum(['created', 'inventory_complete', 'basecamp_complete', 'active', 'archived']),
});

engagements.patch('/:id/status', zValidator('json', updateStatusSchema), async (c) => {
    const id = c.req.param('id');
    const { status } = c.req.valid('json');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { error } = await supabase
        .from('engagements')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id);

    if (error) {
        log.error({ error }, 'Failed to update engagement status');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ success: true });
});

// Update SITUATION.md
const updateSituationSchema = z.object({
    situationMd: z.string(),
});

engagements.put('/:id/situation', zValidator('json', updateSituationSchema), async (c) => {
    const id = c.req.param('id');
    const { situationMd } = c.req.valid('json');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    // Get engagement to find local path
    const { data: engagement, error: fetchError } = await supabase
        .from('engagements')
        .select('local_path')
        .eq('id', id)
        .single();

    if (fetchError) {
        return c.json({ error: 'Engagement not found' }, 404);
    }

    // Write to file system if local path exists
    if (engagement.local_path) {
        const situationPath = join(engagement.local_path, 'SITUATION.md');
        await writeFile(situationPath, situationMd, 'utf-8');
        log.info({ id, path: situationPath }, 'Updated SITUATION.md on disk');
    }

    // Update database
    const { error } = await supabase
        .from('engagements')
        .update({ situation_md: situationMd, updated_at: new Date().toISOString() })
        .eq('id', id);

    if (error) {
        log.error({ error }, 'Failed to update SITUATION.md');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ success: true });
});

// Get SITUATION.md content
engagements.get('/:id/situation', async (c) => {
    const id = c.req.param('id');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { data: engagement, error } = await supabase
        .from('engagements')
        .select('situation_md, local_path')
        .eq('id', id)
        .single();

    if (error) {
        return c.json({ error: 'Engagement not found' }, 404);
    }

    // Try to read from file system first (most up-to-date)
    if (engagement.local_path) {
        const situationPath = join(engagement.local_path, 'SITUATION.md');
        if (existsSync(situationPath)) {
            const content = await readFile(situationPath, 'utf-8');
            return c.json({ situationMd: content });
        }
    }

    // Fall back to database
    return c.json({ situationMd: engagement.situation_md || '' });
});

// Upgrade skills to latest version
engagements.post('/:id/upgrade-skills', async (c) => {
    const id = c.req.param('id');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { data: engagement, error: fetchError } = await supabase
        .from('engagements')
        .select('local_path, skill_repository, skill_version')
        .eq('id', id)
        .single();

    if (fetchError) {
        return c.json({ error: 'Engagement not found' }, 404);
    }

    if (!engagement.local_path) {
        return c.json({ error: 'Engagement has no local path' }, 400);
    }

    log.info({ id, currentVersion: engagement.skill_version }, 'Upgrading skills');

    try {
        const { version } = await copySkillsToEngagement(engagement.local_path, {
            repository: engagement.skill_repository,
        });

        const { error } = await supabase
            .from('engagements')
            .update({ skill_version: version, updated_at: new Date().toISOString() })
            .eq('id', id);

        if (error) {
            throw error;
        }

        log.info({ id, newVersion: version }, 'Skills upgraded');

        return c.json({ success: true, version });
    } catch (error) {
        log.error({ error }, 'Failed to upgrade skills');
        return c.json({
            error: error instanceof Error ? error.message : 'Failed to upgrade skills'
        }, 500);
    }
});

// Get skill runs for an engagement
engagements.get('/:id/runs', async (c) => {
    const id = c.req.param('id');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { data: runs, error } = await supabase
        .from('skill_runs')
        .select('*')
        .eq('engagement_id', id)
        .order('started_at', { ascending: false });

    if (error) {
        log.error({ error }, 'Failed to get skill runs');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ runs });
});

// Record a skill run
const recordRunSchema = z.object({
    skillName: z.string(),
    status: z.enum(['pending', 'running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled']).default('running'),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
    artifacts: z.array(z.string()).optional(),
});

engagements.post('/:id/runs', zValidator('json', recordRunSchema), async (c) => {
    const id = c.req.param('id');
    const input = c.req.valid('json');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { data: run, error } = await supabase
        .from('skill_runs')
        .insert({
            engagement_id: id,
            skill_name: input.skillName,
            status: input.status,
            input_tokens: input.inputTokens || null,
            output_tokens: input.outputTokens || null,
            cost_usd: input.costUsd || null,
            artifacts: input.artifacts || [],
        })
        .select()
        .single();

    if (error) {
        log.error({ error }, 'Failed to create skill run');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ run }, 201);
});

// Update a skill run
const updateRunSchema = z.object({
    status: z.enum(['pending', 'running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled']).optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
    artifacts: z.array(z.string()).optional(),
    errorMessage: z.string().optional(),
});

engagements.patch('/:engagementId/runs/:runId', zValidator('json', updateRunSchema), async (c) => {
    const runId = c.req.param('runId');
    const input = c.req.valid('json');

    try {
        z.uuid().parse(runId);
    } catch {
        return c.json({ error: 'Invalid run ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.status) {
        updates.status = input.status;
        if (['completed', 'failed', 'cancelled'].includes(input.status)) {
            updates.completed_at = new Date().toISOString();
        }
    }
    if (input.inputTokens !== undefined) updates.input_tokens = input.inputTokens;
    if (input.outputTokens !== undefined) updates.output_tokens = input.outputTokens;
    if (input.costUsd !== undefined) updates.cost_usd = input.costUsd;
    if (input.artifacts !== undefined) updates.artifacts = input.artifacts;
    if (input.errorMessage !== undefined) updates.error_message = input.errorMessage;

    const { error } = await supabase
        .from('skill_runs')
        .update(updates)
        .eq('id', runId);

    if (error) {
        log.error({ error }, 'Failed to update skill run');
        return c.json({ error: error.message }, 500);
    }

    return c.json({ success: true });
});

// Skill repository endpoints

// Sync skill repository (refresh cache)
engagements.post('/skills/sync', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repository = body.repository || 'vasegu/rx-skills';
    const branch = body.branch || 'main';

    log.info({ repository, branch }, 'Syncing skill repository');

    try {
        const info = await syncSkillRepository({ repository, branch });
        return c.json({ success: true, ...info });
    } catch (error) {
        log.error({ error }, 'Failed to sync skill repository');
        return c.json({
            error: error instanceof Error ? error.message : 'Failed to sync repository'
        }, 500);
    }
});

// Get current skill version
engagements.get('/skills/version', async (c) => {
    const repository = c.req.query('repository') || 'vasegu/rx-skills';

    const version = await getSkillVersion(repository);
    return c.json({ version, repository });
});

// List available skill versions (tags)
engagements.get('/skills/versions', async (c) => {
    const repository = c.req.query('repository') || 'vasegu/rx-skills';
    const branch = c.req.query('branch') || 'main';

    const versions = await listSkillVersions({ repository, branch });
    return c.json({ versions, repository });
});

// Delete an engagement
engagements.delete('/:id', async (c) => {
    const id = c.req.param('id');

    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid engagement ID' }, 400);
    }

    const supabase = getSupabaseAdmin();

    const { error } = await supabase
        .from('engagements')
        .delete()
        .eq('id', id);

    if (error) {
        log.error({ error }, 'Failed to delete engagement');
        return c.json({ error: error.message }, 500);
    }

    log.info({ id }, 'Engagement deleted');

    return c.json({ success: true });
});

export default engagements;
