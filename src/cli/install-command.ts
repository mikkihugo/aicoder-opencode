/**
 * Install command logic for propagating shared control-plane assets to target overlays.
 *
 * Responsibilities:
 * - Copy canonical `.opencode/{agents,plugins,commands}/` into the target overlay.
 * - Create absolute symlinks in the target repo pointing to the overlay.
 * - Support `--check` dry-run mode.
 * - Never delete overlay extras (merge-up semantics).
 * - Fail hard if the target repo already has a real file/dir blocking a symlink path.
 */

import { access, cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";

export type InstallAssetKind = "agents" | "plugins" | "commands";

export type InstallResult = {
  kind: InstallAssetKind;
  sourceDir: string;
  overlayDir: string;
  targetLink: string;
  copied: boolean;
  symlinkCreated: boolean;
  symlinkCorrect: boolean;
};

export type InstallCheckResult = {
  kind: InstallAssetKind;
  sourceDir: string;
  overlayDir: string;
  targetLink: string;
  sourceExists: boolean;
  overlayExists: boolean;
  symlinkCorrect: boolean;
  error: string | null;
};

const INSTALL_ASSET_KINDS: InstallAssetKind[] = ["agents", "plugins", "commands"];

/**
 * Determine whether a path exists and what kind of entry it is.
 */
async function inspectPath(
  filePath: string,
): Promise<{ exists: false } | { exists: true; isSymlink: boolean; isDirectory: boolean }> {
  try {
    const stats = await lstat(filePath);
    return {
      exists: true,
      isSymlink: stats.isSymbolicLink(),
      isDirectory: stats.isDirectory(),
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Verify that a symlink points to the expected absolute target.
 */
async function verifySymlink(
  linkPath: string,
  expectedTarget: string,
): Promise<boolean> {
  try {
    const actualTarget = await readlink(linkPath);
    return path.resolve(actualTarget) === path.resolve(expectedTarget);
  } catch {
    return false;
  }
}

/**
 * Install shared assets for one target.
 *
 * Args:
 *   controlPlaneRoot: Absolute path to the aicoder-opencode repository root.
 *   targetName: Target slug (must match a config file name).
 *   targetRoot: Absolute path to the target repository root.
 *   dryRun: When true, do not mutate the filesystem; only report what would happen.
 *
 * Returns:
 *   Array of per-asset results.
 *
 * Raises:
 *   Error: When a real file or directory blocks a symlink path in the target repo.
 */
export async function installTargetAssets(
  controlPlaneRoot: string,
  targetName: string,
  targetRoot: string,
  dryRun: boolean,
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];

  for (const kind of INSTALL_ASSET_KINDS) {
    const sourceDir = path.join(controlPlaneRoot, ".opencode", kind);
    const overlayDir = path.join(
      controlPlaneRoot,
      "targets",
      targetName,
      "overlay",
      ".opencode",
      kind,
    );
    const targetLink = path.join(targetRoot, ".opencode", kind);

    const sourceInfo = await inspectPath(sourceDir);
    const targetInfo = await inspectPath(targetLink);

    let copied = false;
    if (sourceInfo.exists && sourceInfo.isDirectory && !sourceInfo.isSymlink) {
      if (!dryRun) {
        await mkdir(path.dirname(overlayDir), { recursive: true });
        await cp(sourceDir, overlayDir, {
          recursive: true,
          dereference: true,
          force: true,
        });
      }
      copied = true;
    }

    if (targetInfo.exists && !targetInfo.isSymlink) {
      throw new Error(
        `install blocked: ${targetLink} exists as a real file or directory. ` +
          `Move or merge it manually before installing the overlay symlink.`,
      );
    }

    let symlinkCreated = false;
    let symlinkCorrect = false;
    if (!dryRun) {
      if (!targetInfo.exists) {
        await mkdir(path.dirname(targetLink), { recursive: true });
        await symlink(path.resolve(overlayDir), targetLink);
        symlinkCreated = true;
        symlinkCorrect = true;
      } else {
        symlinkCorrect = await verifySymlink(targetLink, overlayDir);
        if (!symlinkCorrect) {
          await rm(targetLink);
          await symlink(path.resolve(overlayDir), targetLink);
          symlinkCreated = true;
          symlinkCorrect = true;
        }
      }
    } else {
      symlinkCorrect = targetInfo.exists && targetInfo.isSymlink && await verifySymlink(targetLink, overlayDir);
    }

    results.push({
      kind,
      sourceDir,
      overlayDir,
      targetLink,
      copied,
      symlinkCreated,
      symlinkCorrect,
    });
  }

  return results;
}

/**
 * Check whether shared assets are correctly installed for one target.
 *
 * Args:
 *   controlPlaneRoot: Absolute path to the aicoder-opencode repository root.
 *   targetName: Target slug.
 *   targetRoot: Absolute path to the target repository root.
 *
 * Returns:
 *   Array of per-asset check results. Any non-null `error` indicates a problem.
 */
export async function checkTargetAssets(
  controlPlaneRoot: string,
  targetName: string,
  targetRoot: string,
): Promise<InstallCheckResult[]> {
  const results: InstallCheckResult[] = [];

  for (const kind of INSTALL_ASSET_KINDS) {
    const sourceDir = path.join(controlPlaneRoot, ".opencode", kind);
    const overlayDir = path.join(
      controlPlaneRoot,
      "targets",
      targetName,
      "overlay",
      ".opencode",
      kind,
    );
    const targetLink = path.join(targetRoot, ".opencode", kind);

    const sourceInfo = await inspectPath(sourceDir);
    const overlayInfo = await inspectPath(overlayDir);
    const targetInfo = await inspectPath(targetLink);

    let error: string | null = null;
    if (targetInfo.exists && !targetInfo.isSymlink) {
      error = `install blocked: ${targetLink} exists as a real file or directory`;
    } else if (targetInfo.exists && targetInfo.isSymlink) {
      const correct = await verifySymlink(targetLink, overlayDir);
      if (!correct) {
        error = `symlink ${targetLink} points to the wrong target`;
      }
    } else if (sourceInfo.exists && !overlayInfo.exists) {
      error = `overlay missing: ${overlayDir} does not exist`;
    } else if (sourceInfo.exists && !targetInfo.exists) {
      error = `symlink missing: ${targetLink} does not exist`;
    }

    results.push({
      kind,
      sourceDir,
      overlayDir,
      targetLink,
      sourceExists: sourceInfo.exists && sourceInfo.isDirectory && !sourceInfo.isSymlink,
      overlayExists: overlayInfo.exists && overlayInfo.isDirectory && !overlayInfo.isSymlink,
      symlinkCorrect: targetInfo.exists && targetInfo.isSymlink && await verifySymlink(targetLink, overlayDir),
      error,
    });
  }

  return results;
}
