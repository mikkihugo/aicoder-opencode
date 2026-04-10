# Target Onboarding Guide

## Overview

This comprehensive guide provides step-by-step instructions for onboarding new target repositories to the aicoder-opencode control plane. It covers all aspects from initial assessment to full integration.

## Onboarding Process Overview

```
┌───────────────────────────────────────────────────┐
│                 Pre-Onboarding Assessment         │
└───────────────────────────────────────────────────┘
                                ↓
┌───────────────────────────────────────────────────┐
│                    Configuration Setup           │
└───────────────────────────────────────────────────┘
                                ↓
┌───────────────────────────────────────────────────┐
│                   Validation & Testing              │
└───────────────────────────────────────────────────┘
                                ↓
┌───────────────────────────────────────────────────┐
│                 Integration & Monitoring            │
└───────────────────────────────────────────────────┘
                                ↓
┌───────────────────────────────────────────────────┐
│                    Production Rollout              │
└───────────────────────────────────────────────────┘
```

## Pre-Onboarding Assessment

### Target Repository Requirements

**Mandatory Requirements:**
- Git repository with clean history
- Valid `package.json` or equivalent manifest
- Node.js 18+ or Python 3.9+ runtime
- Clean dependency tree (no known vulnerabilities)
- Working build/test process

**Recommended Requirements:**
- TypeScript support (for JavaScript projects)
- Ruff/Pyright (for Python projects)
- Pre-commit hooks configured
- CI/CD pipeline established
- Documentation in Markdown format

### Compatibility Checklist

```markdown
- [ ] Repository uses supported runtime (Node.js 18+/20+ or Python 3.9+)
- [ ] No forbidden dependencies (left-pad, lodash, etc.)
- [ ] Clean security audit (no critical vulnerabilities)
- [ ] Working build process
- [ ] Passing test suite
- [ ] Proper documentation structure
- [ ] Compatible license (MIT, Apache 2.0, etc.)
- [ ] No binary blobs in git history
- [ ] Reasonable repository size (<1GB)
- [ ] No sensitive data in repository
```

### Assessment Process

**1. Automated Compatibility Check:**
```bash
# Run from aicoder-opencode directory
./bin/assess-target-compatibility /path/to/target-repo
```

**2. Manual Review:**
- Repository structure analysis
- Dependency audit
- Build process verification
- Documentation quality assessment
- Security scan review

**3. Compatibility Report:**
- List of issues found
- Remediation requirements
- Estimated effort for fixes
- Go/no-go recommendation

## Configuration Setup

### Target Configuration File

Create a new YAML file in `config/targets/` following the established pattern:

```yaml
# config/targets/[target-name].yaml
name: [target-name]
kind: repo|monorepo  # Repository type
root: /absolute/path/to/repository
default_branch: main  # Default git branch
maintenance_owner: aicoder-opencode  # Control plane owner
instruction_path: docs/targets/[target-name].md  # Instructions file

# Optional: Product launcher configuration
product_launcher:
  type: opencode|custom
  mode: product
  executable_path: /path/to/executable
  sandbox_kind: bubblewrap|none
  
# Optional: Maintenance launcher configuration
maintenance_launcher:
  type: opencode|custom
  mode: maintenance
  executable_path: /path/to/executable

# Optional: Hidden paths (maintenance state)
hidden_paths:
  - .opencode
  - .agents
  - .maintenance

# Optional: Subprojects (for monorepos)
subprojects:
  - name: subproject-name
    root: /absolute/path/to/subproject

# Optional: Notes and special instructions
notes:
  - Special considerations for this target
  - Integration requirements
  - Known limitations
```

### Target Instructions File

Create a corresponding instructions file in `docs/targets/`:

```markdown
# [target-name] target instructions

## Role

Describe the target's role and purpose in the ecosystem.

## What belongs here

- Product code and features
- Product tests and test data
- Product documentation
- Product-specific configuration

## What does not belong here

- Shared maintenance logic
- Cross-repo policy
- Control plane code
- Generic utilities

## Control-plane expectations

- Launch requirements
- Maintenance boundaries
- Integration points
- Compliance requirements

## Maintenance boundary

Describe what maintenance aspects should be handled by the control plane vs. locally.
```

### Configuration Validation

**Validate the configuration:**
```bash
make validate-[target-name]
```

**Expected output:**
```
[target-name]: ok
```

### Target Registration

**Add target to registry:**
```bash
# Edit config/control-plane.yaml
target_registry:
  directory: config/targets
  supported_kinds:
    - repo
    - monorepo
```

**Verify registration:**
```bash
make targets
# Should list the new target
```

## Validation & Testing

### Validation Process

**1. Basic Validation:**
```bash
make validate-[target-name]
```

**2. Launch Validation:**
```bash
make print-[target-name]-launch -- --help
```

**3. Sandbox Validation:**
```bash
make debug-[target-name]-sandbox
```

### Testing Checklist

```markdown
- [ ] Target configuration validates successfully
- [ ] Target appears in `make targets` output
- [ ] Launch command works (--help shows usage)
- [ ] Sandbox shows expected structure
- [ ] Hidden paths are properly concealed
- [ ] Product launcher functions correctly
- [ ] Maintenance launcher functions correctly
- [ ] Health checks pass
- [ ] Basic operations work
- [ ] Error handling is appropriate
```

### Common Validation Issues

**Issue: Configuration validation fails**
- Check YAML syntax
- Verify all required fields present
- Ensure paths are absolute and correct
- Validate executable paths exist

**Issue: Launch command not found**
- Verify target name matches configuration
- Check Makefile has appropriate targets
- Ensure CLI supports the target type

**Issue: Sandbox structure incorrect**
- Verify hidden paths configuration
- Check sandbox launcher settings
- Validate path mappings

## Integration & Monitoring

### Control Plane Integration

**1. Add to monitoring:**
```bash
# Edit monitoring configuration
vim monitoring/openportal/config/thresholds.yaml

# Add target-specific alerts
- name: [target-name]_validation_failure
  description: [target-name] validation failed
  severity: critical
  condition: component('[target-name]').status == 'critical'
  threshold: 1
  cooldown: 1800
  notifications: [email, dashboard]
```

**2. Add to doctrine validation:**
```bash
# Create doctrine contract
cp doctrine/contracts/base.contract.yaml doctrine/contracts/[target-name].contract.yaml

# Customize for target
vim doctrine/contracts/[target-name].contract.yaml
```

**3. Add to memory system:**
```bash
# Ensure target is included in pattern analysis
# Edit memory/api/analysis.ts
const TARGETS = ['dr-repo', 'letta-workspace', '[target-name]'];
```

### Monitoring Setup

**1. Add health checks:**
```typescript
// Add to health checker
this.checks.push(
  new TargetValidationCheck('[target-name]'),
  new TargetLaunchReadinessCheck('[target-name]')
);
```

**2. Add metrics collection:**
```typescript
// Add to metrics collector
this.targets.push('[target-name]');
```

**3. Add alerting rules:**
```yaml
# Add target-specific alerts
- name: [target-name]_launch_failure
  description: [target-name] launch failed
  severity: critical
  condition: component('[target-name]_launcher').status == 'critical'
  threshold: 1
  cooldown: 3600
  notifications: [email, dashboard]
```

### Integration Testing

**Test the integration:**
```bash
# Run full health check
./bin/check-health --full

# Verify target appears in dashboard
./bin/monitoring-dashboard

# Test alerting for target issues
./bin/test-alert [target-name]_validation_failure
```

## Production Rollout

### Rollout Checklist

```markdown
- [ ] Target configuration validated
- [ ] Target instructions documented
- [ ] Integration tests passing
- [ ] Monitoring configured
- [ ] Alerting rules in place
- [ ] Doctrine contract created
- [ ] Memory system updated
- [ ] Health checks passing
- [ ] Backup created
- [ ] Team notified
- [ ] Rollout window confirmed
```

### Rollout Process

**1. Pre-rollout preparation:**
```bash
# Create backup
./bin/backup-target [target-name] --full

# Notify team
./bin/notify-team "Adding [target-name] to control plane"

# Schedule rollout
./bin/schedule-rollout [target-name] --time "2024-01-01T12:00:00Z"
```

**2. Rollout execution:**
```bash
# Enable target in control plane
./bin/enable-target [target-name]

# Start monitoring
./bin/start-monitoring [target-name]

# Verify health
./bin/check-target-health [target-name]

# Run smoke tests
./bin/smoke-test [target-name]
```

**3. Post-rollout verification:**
```bash
# Monitor for 24 hours
./bin/monitor-target [target-name] --duration 24h

# Check alert history
./bin/check-alerts --target [target-name]

# Verify integration
./bin/verify-integration [target-name]

# Update documentation
./bin/update-docs [target-name]
```

### Rollback Procedure

**Rollback triggers:**
- Critical failures in target operations
- Control plane instability
- Security incidents
- Data corruption
- Unresolvable issues within 1 hour

**Rollback steps:**
```bash
# Disable target
./bin/disable-target [target-name]

# Stop monitoring
./bin/stop-monitoring [target-name]

# Restore from backup
./bin/restore-target [target-name] --backup latest

# Notify team
./bin/notify-team "Rolled back [target-name] - investigating issues"

# Analyze failure
./bin/analyze-failure [target-name] --since 1h
```

## Maintenance & Operations

### Routine Maintenance Tasks

**Daily:**
- Check target health status
- Review any alerts or warnings
- Verify monitoring data collection
- Check doctrine compliance

**Weekly:**
- Review target metrics trends
- Update doctrine contract if needed
- Test fallback procedures
- Review alerting rules effectiveness

**Monthly:**
- Comprehensive target validation
- Dependency audit
- Security scan
- Performance review

### Common Maintenance Operations

**Update target configuration:**
```bash
vim config/targets/[target-name].yaml
make validate-[target-name]
./bin/reload-configuration
```

**Update doctrine contract:**
```bash
vim doctrine/contracts/[target-name].contract.yaml
./bin/validate-doctrine [target-name]
./bin/apply-doctrine [target-name]
```

**Run maintenance operation:**
```bash
./bin/maintenance [target-name] --operation validate
./bin/maintenance [target-name] --operation cleanup
./bin/maintenance [target-name] --operation optimize
```

### Troubleshooting Guide

**Issue: Target validation fails**
```bash
# Check validation details
./bin/validate-target [target-name] --verbose

# Check logs
./bin/check-logs --target [target-name] --since 1h

# Run diagnostic
./bin/diagnose [target-name]
```

**Issue: Target launch fails**
```bash
# Check launch configuration
./bin/check-launch-config [target-name]

# Test launch manually
./bin/test-launch [target-name] --dry-run

# Check sandbox
./bin/debug-sandbox [target-name]
```

**Issue: Monitoring not working**
```bash
# Check monitoring status
./bin/monitoring-status [target-name]

# Test health check
./bin/test-health-check [target-name]

# Restart monitoring
./bin/restart-monitoring [target-name]
```

## Advanced Topics

### Monorepo Onboarding

**Additional requirements for monorepos:**
- Clear subproject boundaries
- Shared dependency management
- Consistent tooling across subprojects
- Monorepo-aware build system

**Configuration example:**
```yaml
name: example-workspace
kind: monorepo
root: /home/user/code/example-workspace
subprojects:
  - name: core
    root: /home/user/code/example-workspace/core
  - name: cli
    root: /home/user/code/example-workspace/cli
  - name: web
    root: /home/user/code/example-workspace/web
```

### Custom Launcher Integration

**For targets with custom launchers:**
```yaml
product_launcher:
  type: custom
  mode: product
  executable_path: /path/to/custom-launcher
  arguments: ["--mode", "product"]
  environment:
    CUSTOM_ENV: "value"
  
maintenance_launcher:
  type: custom
  mode: maintenance
  executable_path: /path/to/custom-launcher
  arguments: ["--mode", "maintenance"]
```

### Cross-Target Dependencies

**For targets with dependencies on other targets:**
```yaml
dependencies:
  - target: letta-workspace
    components: [letta-core]
    version: "^1.0.0"
  - target: dr-repo
    components: [portal]
    version: "^2.0.0"

dependency_rules:
  - rule: "letta-workspace must be healthy before dr-repo operations"
    condition: "letta-workspace.status == 'healthy'"
    action: "block"
```

## Security Considerations

### Security Requirements

**Mandatory security measures:**
- No sensitive data in repository
- Regular dependency security scans
- Secure credential management
- Principle of least privilege
- Audit logging for all operations

**Security validation:**
```bash
# Run security scan
./bin/security-scan [target-name]

# Check for secrets
./bin/secrets-scan [target-name]

# Validate permissions
./bin/permissions-audit [target-name]
```

### Security Integration

**Add to security monitoring:**
```bash
# Add security alerts
./bin/add-security-alerts [target-name]

# Configure automated scans
./bin/configure-security-scans [target-name] --schedule daily

# Set up notification for security issues
./bin/setup-security-notifications [target-name] --email security-team@example.com
```

## Success Criteria

### Onboarding Success Metrics

**Technical Success:**
- Target configuration validates successfully
- All validation tests pass
- Integration completed without issues
- Monitoring and alerting functional
- Doctrine compliance >90%

**Operational Success:**
- Target operations stable for 7 days
- No critical alerts triggered
- Team can perform basic operations
- Documentation is complete and accurate
- Monitoring provides actionable insights

**Business Success:**
- Target fully integrated into control plane
- Maintenance operations centralized
- Cross-repo consistency achieved
- Team productivity improved
- System reliability maintained or improved

## Timeline & Resources

### Estimated Timeline

```
Day 1-2: Pre-onboarding assessment and compatibility check
Day 3-4: Configuration setup and initial validation
Day 5-6: Integration testing and monitoring setup
Day 7:   Production rollout and verification
Day 8-14: Monitoring and stabilization period
```

**Total Estimated Time:** 2 weeks
**Team Required:**
- 1 Control Plane Engineer (50% time)
- 1 Target Expert (25% time)
- 1 QA Engineer (10% time)

### Resource Requirements

**Infrastructure:**
- Minimal (existing control plane capacity)
- <100MB additional storage per target
- <5% additional CPU usage

**Tooling:**
- Standard control plane tools
- Target-specific build/test tools
- Monitoring and alerting infrastructure

## Checklist & Sign-off

### Final Onboarding Checklist

```markdown
- [ ] Pre-onboarding assessment completed
- [ ] Compatibility issues resolved
- [ ] Target configuration created and validated
- [ ] Target instructions documented
- [ ] Basic validation tests passing
- [ ] Launch configuration working
- [ ] Sandbox structure correct
- [ ] Integration tests passing
- [ ] Monitoring configured
- [ ] Alerting rules in place
- [ ] Doctrine contract created
- [ ] Memory system updated
- [ ] Security scans clean
- [ ] Backup created
- [ ] Team trained
- [ ] Rollout plan approved
- [ ] Production rollout completed
- [ ] Post-rollout verification successful
- [ ] Documentation updated
- [ ] Onboarding complete notification sent
```

### Approval Sign-off

**Required Approvals:**
- [ ] Control Plane Architect
- [ ] Target Owner
- [ ] Security Review
- [ ] QA Sign-off
- [ ] Operations Approval
- [ ] Final Go/No-Go Decision

## Support & Escalation

### Support Channels

**Primary Support:**
- Control Plane Team: #control-plane on Slack
- Email: control-plane@aicoder.example.com
- Issue Tracker: GitHub issues with `target-onboarding` label

**Escalation Path:**
1. Control Plane Engineer on duty
2. Control Plane Team Lead
3. Infrastructure Team
4. Security Team (for security issues)

### Common Issues & Resolutions

**Issue: Target not appearing in `make targets`**
- Verify configuration file exists in `config/targets/`
- Check YAML syntax is valid
- Ensure file has correct permissions
- Restart control plane if needed

**Issue: Validation fails with unclear error**
- Run with `--verbose` flag for details
- Check control plane logs
- Verify all required fields present
- Consult documentation for specific error

**Issue: Launch command hangs or fails**
- Check sandbox configuration
- Verify executable paths
- Test launcher manually
- Check resource limits

## Appendix

### Configuration Examples

**Simple Repository:**
```yaml
name: simple-repo
kind: repo
root: /home/user/code/simple-repo
default_branch: main
maintenance_owner: aicoder-opencode
instruction_path: docs/targets/simple-repo.md
```

**Complex Monorepo:**
```yaml
name: complex-workspace
kind: monorepo
root: /home/user/code/complex-workspace
default_branch: main
maintenance_owner: aicoder-opencode
instruction_path: docs/targets/complex-workspace.md

subprojects:
  - name: core
    root: /home/user/code/complex-workspace/core
  - name: cli
    root: /home/user/code/complex-workspace/cli
  - name: web
    root: /home/user/code/complex-workspace/web
  - name: mobile
    root: /home/user/code/complex-workspace/mobile

product_launcher:
  type: custom
  mode: product
  executable_path: /home/user/code/complex-workspace/bin/launch
  arguments: ["--mode", "product"]
  sandbox_kind: none

maintenance_launcher:
  type: custom
  mode: maintenance
  executable_path: /home/user/code/complex-workspace/bin/launch
  arguments: ["--mode", "maintenance"]

hidden_paths:
  - .internal
  - .maintenance
  - build/cache

notes:
  - Requires Java 17 for mobile subproject
  - Web subproject needs Node.js 20+
  - Shared dependencies managed by root package.json
```

### Command Reference

**Validation Commands:**
```bash
make validate-[target]           # Validate target configuration
make show-[target]             # Show target details
make debug-[target]-sandbox     # Debug target sandbox
```

**Monitoring Commands:**
```bash
./bin/check-health [target]     # Check target health
./bin/monitoring-status [target] # Show monitoring status
./bin/check-alerts [target]     # Check active alerts
```

**Maintenance Commands:**
```bash
./bin/maintenance [target] --operation validate
./bin/maintenance [target] --operation cleanup
./bin/maintenance [target] --operation optimize
```

## Approval & Next Steps

**Document Approval:**
- [ ] Control Plane Architect
- [ ] Documentation Review
- [ ] Target Onboarding Team

**Next Steps for New Target:**
1. Review this guide thoroughly
2. Gather target information
3. Perform pre-onboarding assessment
4. Create target configuration
5. Follow onboarding process step-by-step
6. Validate at each stage
7. Request final approval
8. Complete production rollout
9. Monitor post-rollout stability
10. Update documentation as needed

**Feedback & Improvements:**
This guide will be updated based on real-world onboarding experiences. Please submit feedback and suggestions to improve the process.
