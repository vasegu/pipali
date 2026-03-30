/**
 * Skill Fetcher - pulls skills from a versioned repository
 *
 * Fetches skills from rx-skills repo and copies them to engagement directories.
 * Tracks version for reproducibility and incident tracing.
 */

import { join } from 'path';
import { mkdir, cp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { $ } from 'bun';
import { createChildLogger } from '../logger';
import { getSkillCachePath, getEngagementsPath } from '../paths';

const log = createChildLogger({ component: 'skill-fetcher' });

export interface SkillRepositoryConfig {
    /** GitHub repository (e.g., 'vasegu/rx-skills') */
    repository?: string;
    /** Branch to use (default: 'main') */
    branch?: string;
    /** Path within repo where skills live (default: '.claude/skills') */
    skillsPath?: string;
    /** Path to scripts (default: '.claude/scripts') */
    scriptsPath?: string;
}

export interface FetchedSkillInfo {
    /** Git commit hash */
    version: string;
    /** Repository URL */
    repository: string;
    /** Branch used */
    branch: string;
    /** Path to cached skills */
    cachePath: string;
}

const DEFAULT_CONFIG: Required<SkillRepositoryConfig> = {
    repository: 'vasegu/rx-skills',
    branch: 'main',
    skillsPath: '.claude/skills',
    scriptsPath: '.claude/scripts',
};

/**
 * Get the cache path for a repository
 */
function getRepoCachePath(repository: string): string {
    const safeName = repository.replace('/', '-');
    return join(getSkillCachePath(), safeName);
}

/**
 * Clone or update the skills repository to local cache
 */
export async function syncSkillRepository(
    config: SkillRepositoryConfig = {}
): Promise<FetchedSkillInfo> {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    const { repository, branch } = fullConfig;
    const cachePath = getRepoCachePath(repository);

    log.info({ repository, branch, cachePath }, 'Syncing skill repository');

    // Create cache directory if needed
    await mkdir(getSkillCachePath(), { recursive: true });

    const repoUrl = `https://github.com/${repository}.git`;

    if (existsSync(cachePath)) {
        // Repository already cloned, fetch and checkout latest
        log.debug({ cachePath }, 'Repository already cached, pulling updates');
        try {
            await $`git -C ${cachePath} fetch origin ${branch}`.quiet();
            await $`git -C ${cachePath} checkout ${branch}`.quiet();
            await $`git -C ${cachePath} reset --hard origin/${branch}`.quiet();
        } catch (error) {
            log.error({ error }, 'Failed to update cached repository, re-cloning');
            await rm(cachePath, { recursive: true, force: true });
            await $`git clone --branch ${branch} --single-branch ${repoUrl} ${cachePath}`.quiet();
        }
    } else {
        // Clone fresh
        log.info({ repoUrl, cachePath }, 'Cloning skill repository');
        await $`git clone --branch ${branch} --single-branch ${repoUrl} ${cachePath}`.quiet();
    }

    // Get the current commit hash for version tracking
    const result = await $`git -C ${cachePath} rev-parse --short HEAD`.quiet();
    const version = result.text().trim();

    log.info({ repository, branch, version }, 'Skill repository synced');

    return {
        version,
        repository,
        branch,
        cachePath,
    };
}

/**
 * Copy skills from cache to an engagement directory
 */
export async function copySkillsToEngagement(
    engagementPath: string,
    config: SkillRepositoryConfig = {}
): Promise<{ version: string; skillsPath: string; scriptsPath: string }> {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    const cachePath = getRepoCachePath(fullConfig.repository);

    // Ensure cache is up to date
    const { version } = await syncSkillRepository(config);

    // Source paths in cache
    const sourceSkills = join(cachePath, fullConfig.skillsPath);
    const sourceScripts = join(cachePath, fullConfig.scriptsPath);

    // Target paths in engagement
    const targetSkillsDir = join(engagementPath, '.claude', 'skills');
    const targetScriptsDir = join(engagementPath, '.claude', 'scripts');

    // Create target directories
    await mkdir(targetSkillsDir, { recursive: true });
    await mkdir(targetScriptsDir, { recursive: true });

    // Copy skills
    if (existsSync(sourceSkills)) {
        await cp(sourceSkills, targetSkillsDir, { recursive: true });
        log.info({ from: sourceSkills, to: targetSkillsDir }, 'Copied skills');
    }

    // Copy scripts
    if (existsSync(sourceScripts)) {
        await cp(sourceScripts, targetScriptsDir, { recursive: true });
        log.info({ from: sourceScripts, to: targetScriptsDir }, 'Copied scripts');
    }

    return {
        version,
        skillsPath: targetSkillsDir,
        scriptsPath: targetScriptsDir,
    };
}

/**
 * Create a new engagement directory with skills
 */
export async function createEngagementDirectory(
    clientSlug: string,
    config: SkillRepositoryConfig = {}
): Promise<{ path: string; version: string }> {
    const engagementsRoot = getEngagementsPath();
    const engagementPath = join(engagementsRoot, clientSlug);

    // Create engagement directory
    await mkdir(engagementPath, { recursive: true });

    // Initialize standard directories
    await mkdir(join(engagementPath, 'data'), { recursive: true });
    await mkdir(join(engagementPath, 'reports'), { recursive: true });
    await mkdir(join(engagementPath, 'inputs'), { recursive: true });

    // Copy skills
    const { version } = await copySkillsToEngagement(engagementPath, config);

    log.info({ clientSlug, engagementPath, version }, 'Created engagement directory');

    return { path: engagementPath, version };
}

/**
 * Get the current skill version for a cached repository
 */
export async function getSkillVersion(
    repository: string = DEFAULT_CONFIG.repository
): Promise<string | null> {
    const cachePath = getRepoCachePath(repository);

    if (!existsSync(cachePath)) {
        return null;
    }

    try {
        const result = await $`git -C ${cachePath} rev-parse --short HEAD`.quiet();
        return result.text().trim();
    } catch {
        return null;
    }
}

/**
 * List available skill versions (tags) from the repository
 */
export async function listSkillVersions(
    config: SkillRepositoryConfig = {}
): Promise<string[]> {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    const cachePath = getRepoCachePath(fullConfig.repository);

    // Ensure cache exists
    if (!existsSync(cachePath)) {
        await syncSkillRepository(config);
    }

    try {
        const result = await $`git -C ${cachePath} tag --sort=-version:refname`.quiet();
        return result.text().trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}
