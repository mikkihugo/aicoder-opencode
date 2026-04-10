# OpenPortal Monitoring & Alerting System

## Overview

The OpenPortal Monitoring & Alerting System provides comprehensive observability, health monitoring, and proactive alerting for the aicoder-opencode control plane's OpenPortal instance.

## System Architecture

### Core Components

```
aicoder-opencode/
├── monitoring/
│   ├── openportal/
│   │   ├── health/
│   │   │   ├── checks.ts           # Health check implementations
│   │   │   └── status.ts           # Status tracking
│   │   ├── metrics/
│   │   │   ├── collector.ts         # Metrics collection
│   │   │   └── storage.ts          # Metrics storage
│   │   ├── alerts/
│   │   │   ├── rules.ts            # Alerting rules
│   │   │   ├── engine.ts           # Alerting engine
│   │   │   └── notifications.ts    # Notification system
│   │   ├── dashboard/
│   │   │   ├── ui.ts               # Dashboard UI
│   │   │   └── api.ts              # Dashboard API
│   │   └── config/
│   │       ├── thresholds.yaml     # Alert thresholds
│   │       └── notifications.yaml  # Notification config
│   └── shared/
│       ├── utils/                 # Shared utilities
│       └── models/                # Data models
```

### Data Model

**Health Status:**
```typescript
interface OpenPortalHealthStatus {
  timestamp: Date;
  version: string;
  uptimeSeconds: number;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  components: ComponentHealth[];
  metrics: SystemMetrics;
  alerts: ActiveAlert[];
}

interface ComponentHealth {
  name: string;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  message?: string;
  details?: Record<string, any>;
  since: Date;
}

interface SystemMetrics {
  memory: MemoryMetrics;
  cpu: CPUMetrics;
  processes: ProcessMetrics;
  requests: RequestMetrics;
  targets: TargetMetrics;
}

interface ActiveAlert {
  id: string;
  rule: string;
  severity: 'info' | 'warning' | 'critical';
  triggeredAt: Date;
  message: string;
  context: Record<string, any>;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}
```

## Health Monitoring

### Health Check Categories

**1. System Health:**
- Process health (OpenPortal, OpenCode server)
- Memory usage and leaks
- CPU utilization
- File descriptor usage
- Disk space availability

**2. Service Health:**
- HTTP server responsiveness
- WebSocket connections
- API endpoint availability
- Authentication system
- Session management

**3. Target Health:**
- Target registry status
- Target validation capability
- Target launch readiness
- Maintenance operation status

**4. Performance Health:**
- Request response times
- Throughput metrics
- Error rates
- Resource contention

### Health Check Implementation

```typescript
class OpenPortalHealthChecker {
  private checks: HealthCheck[];
  
  constructor() {
    this.checks = [
      new ProcessHealthCheck('openportal'),
      new ProcessHealthCheck('opencode'),
      new MemoryUsageCheck({ warning: 0.7, critical: 0.85 }),
      new CPUUsageCheck({ warning: 0.75, critical: 0.9 }),
      new HTTPHealthCheck('http://127.0.0.1:3091/health'),
      new HTTPHealthCheck('http://127.0.0.1:4091/health'),
      new TargetRegistryCheck(),
      new RequestPerformanceCheck({ warning: 500, critical: 1000 })
    ];
  }
  
  async checkHealth(): Promise<OpenPortalHealthStatus> {
    const results = await Promise.all(
      this.checks.map(check => this.runCheck(check))
    );
    
    return this.aggregateResults(results);
  }
  
  private async runCheck(check: HealthCheck): Promise<ComponentHealth> {
    try {
      const result = await check.perform();
      return {
        name: check.name,
        status: result.status,
        message: result.message,
        details: result.details,
        since: new Date()
      };
    } catch (error) {
      return {
        name: check.name,
        status: 'critical',
        message: `Check failed: ${error.message}`,
        since: new Date()
      };
    }
  }
}
```

## Metrics Collection

### Collected Metrics

**System Metrics:**
- Memory usage (RSS, heap, external)
- CPU usage (user, system, idle)
- Process count and status
- File descriptor usage
- Disk I/O operations

**HTTP Metrics:**
- Request count and rates
- Response times (p50, p90, p99)
- Error rates by endpoint
- Active connections
- Data transfer volumes

**Target Metrics:**
- Target validation success/failure
- Target launch times
- Maintenance operation duration
- Target health status changes

**Alert Metrics:**
- Alerts triggered/fired
- Alert resolution times
- False positive/negative rates
- Notification delivery success

### Metrics Storage

**Storage Strategy:**
- **Recent metrics** (last 24h): In-memory with 1s resolution
- **Short-term metrics** (last 30d): SQLite with 10s resolution
- **Long-term metrics** (>30d): Compressed archives with 1m resolution
- **Alert history**: Full retention in SQLite

**Retention Policy:**
- Raw metrics: 30 days
- Aggregated metrics: 1 year
- Alert history: 2 years
- Health snapshots: 90 days

## Alerting System

### Alerting Rules

**Default Alert Rules:**

```yaml
# thresholds.yaml
alerts:
  - name: openportal_down
    description: OpenPortal process is not running
    severity: critical
    condition: component('openportal').status == 'critical'
    threshold: 1
    cooldown: 300
    notifications: [email, dashboard]
    
  - name: opencode_down
    description: OpenCode server is not running
    severity: critical
    condition: component('opencode').status == 'critical'
    threshold: 1
    cooldown: 300
    notifications: [email, dashboard]
    
  - name: high_memory_usage
    description: Memory usage exceeds critical threshold
    severity: critical
    condition: metrics.memory.usage > 0.85
    threshold: 5m
    cooldown: 3600
    notifications: [email, dashboard]
    
  - name: high_cpu_usage
    description: CPU usage exceeds critical threshold
    severity: warning
    condition: metrics.cpu.usage > 0.9
    threshold: 2m
    cooldown: 1800
    notifications: [dashboard]
    
  - name: high_error_rate
    description: HTTP error rate exceeds threshold
    severity: warning
    condition: metrics.requests.error_rate > 0.05
    threshold: 5m
    cooldown: 3600
    notifications: [dashboard]
    
  - name: slow_response_time
    description: Response times exceed acceptable limits
    severity: warning
    condition: metrics.requests.p95 > 1000
    threshold: 10m
    cooldown: 7200
    notifications: [dashboard]
    
  - name: target_validation_failure
    description: Target validation failed
    severity: critical
    condition: component('target_registry').status == 'critical'
    threshold: 1
    cooldown: 1800
    notifications: [email, dashboard]
```

### Alerting Engine

```typescript
class AlertingEngine {
  private rules: AlertRule[];
  private activeAlerts: Map<string, ActiveAlert>;
  private cooldowns: Map<string, number>;
  
  constructor(rules: AlertRule[]) {
    this.rules = rules;
    this.activeAlerts = new Map();
    this.cooldowns = new Map();
  }
  
  evaluate(healthStatus: OpenPortalHealthStatus): AlertEvaluationResult {
    const newAlerts: ActiveAlert[] = [];
    const resolvedAlerts: string[] = [];
    
    for (const rule of this.rules) {
      // Check cooldown period
      if (this.cooldowns.has(rule.name)) {
        this.cooldowns.set(rule.name, this.cooldowns.get(rule.name)! - 1);
        if (this.cooldowns.get(rule.name)! > 0) continue;
        this.cooldowns.delete(rule.name);
      }
      
      // Evaluate condition
      const conditionMet = this.evaluateCondition(rule.condition, healthStatus);
      
      if (conditionMet) {
        // Check if this is a new alert or needs to be triggered
        if (!this.activeAlerts.has(rule.name)) {
          const alert = this.createAlert(rule, healthStatus);
          this.activeAlerts.set(rule.name, alert);
          newAlerts.push(alert);
          
          // Set cooldown if specified
          if (rule.cooldown) {
            this.cooldowns.set(rule.name, rule.cooldown);
          }
        }
      } else {
        // Condition no longer met - resolve if active
        if (this.activeAlerts.has(rule.name)) {
          resolvedAlerts.push(rule.name);
          this.activeAlerts.delete(rule.name);
        }
      }
    }
    
    return { newAlerts, resolvedAlerts };
  }
  
  private createAlert(rule: AlertRule, healthStatus: OpenPortalHealthStatus): ActiveAlert {
    return {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      rule: rule.name,
      severity: rule.severity,
      triggeredAt: new Date(),
      message: rule.description,
      context: this.createAlertContext(rule, healthStatus),
      acknowledged: false
    };
  }
}
```

## Notification System

### Notification Channels

**1. Dashboard Notifications:**
- Real-time updates in OpenPortal UI
- Persistent notification center
- Severity-based coloring and grouping
- Acknowledgment capability

**2. Email Notifications:**
- Critical alerts only
- Summary digests for warnings
- Customizable recipients
- HTML and text formats

**3. Log File Notifications:**
- All alerts written to monitoring log
- Structured JSON format
- Rotating log files
- Retention policy applied

**4. Future Extensions:**
- Slack/Teams webhooks
- PagerDuty integration
- SMS notifications
- Mobile push notifications

### Notification Content

**Alert Notification Structure:**
```typescript
interface AlertNotification {
  alertId: string;
  timestamp: Date;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  context: Record<string, any>;
  actions?: NotificationAction[];
  related?: RelatedResource[];
}

interface NotificationAction {
  label: string;
  url?: string;
  command?: string;
  primary?: boolean;
}

interface RelatedResource {
  type: 'target' | 'component' | 'metric';
  id: string;
  name: string;
  url: string;
}
```

## Dashboard & Visualization

### Dashboard Components

**1. Overview Panel:**
- Current health status indicator
- Uptime statistics
- Active alerts summary
- Quick action buttons

**2. Health Status Panel:**
- Component health matrix
- Status history timeline
- Critical issues highlight
- Last check timestamp

**3. Metrics Panel:**
- Real-time metrics charts
- Historical trends
- Threshold indicators
- Zoom and filter controls

**4. Alerts Panel:**
- Active alerts list
- Alert history
- Acknowledgment controls
- Filtering by severity/type

**5. Target Status Panel:**
- Target health overview
- Validation status
- Launch readiness
- Maintenance operation queue

### Dashboard Implementation

```typescript
class MonitoringDashboard {
  private healthStatus: OpenPortalHealthStatus | null;
  private metricsHistory: SystemMetrics[];
  private activeAlerts: ActiveAlert[];
  private alertHistory: ActiveAlert[];
  
  constructor() {
    this.healthStatus = null;
    this.metricsHistory = [];
    this.activeAlerts = [];
    this.alertHistory = [];
  }
  
  updateHealthStatus(status: OpenPortalHealthStatus) {
    this.healthStatus = status;
    this.updateMetricsHistory(status.metrics);
    this.updateActiveAlerts(status.alerts);
    this.render();
  }
  
  private updateMetricsHistory(currentMetrics: SystemMetrics) {
    // Keep last 100 metrics points
    this.metricsHistory.push(currentMetrics);
    if (this.metricsHistory.length > 100) {
      this.metricsHistory.shift();
    }
  }
  
  private updateActiveAlerts(currentAlerts: ActiveAlert[]) {
    // Track alert history and update active alerts
    const newAlerts = currentAlerts.filter(alert => 
      !this.activeAlerts.some(a => a.id === alert.id)
    );
    
    const resolvedAlerts = this.activeAlerts.filter(alert => 
      !currentAlerts.some(a => a.id === alert.id)
    );
    
    // Add resolved alerts to history
    this.alertHistory.push(...resolvedAlerts.map(alert => ({
      ...alert,
      resolvedAt: new Date()
    })));
    
    // Keep last 1000 alerts in history
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-1000);
    }
    
    this.activeAlerts = currentAlerts;
  }
  
  render() {
    // Render all dashboard components
    this.renderOverview();
    this.renderHealthStatus();
    this.renderMetrics();
    this.renderAlerts();
    this.renderTargets();
  }
}
```

## Monitoring Service

### Service Architecture

```typescript
class OpenPortalMonitor {
  private healthChecker: OpenPortalHealthChecker;
  private metricsCollector: MetricsCollector;
  private alertingEngine: AlertingEngine;
  private dashboard: MonitoringDashboard;
  private notifier: NotificationService;
  
  constructor() {
    this.healthChecker = new OpenPortalHealthChecker();
    this.metricsCollector = new MetricsCollector();
    this.alertingEngine = new AlertingEngine(loadAlertRules());
    this.dashboard = new MonitoringDashboard();
    this.notifier = new NotificationService(loadNotificationConfig());
  }
  
  start() {
    // Immediate initial check
    this.runFullCheck();
    
    // Schedule regular checks
    setInterval(() => this.runFullCheck(), 60000); // Every minute
    
    // Schedule detailed metrics collection
    setInterval(() => this.collectDetailedMetrics(), 300000); // Every 5 minutes
  }
  
  private async runFullCheck() {
    try {
      const healthStatus = await this.healthChecker.checkHealth();
      const metrics = await this.metricsCollector.collectMetrics();
      
      // Combine health and metrics
      const fullStatus = { ...healthStatus, metrics };
      
      // Evaluate alerts
      const alertResult = this.alertingEngine.evaluate(fullStatus);
      
      // Update status with any new alerts
      fullStatus.alerts = [...fullStatus.alerts, ...alertResult.newAlerts];
      
      // Update dashboard
      this.dashboard.updateHealthStatus(fullStatus);
      
      // Send notifications for new alerts
      for (const alert of alertResult.newAlerts) {
        await this.notifier.sendAlertNotification(alert);
      }
      
      // Log the check result
      logger.info('Health check completed', {
        status: fullStatus.status,
        alerts: alertResult.newAlerts.length
      });
      
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
    }
  }
}
```

## Integration with Control Plane

### Systemd Service Integration

**Service File:** `/home/mhugo/.config/systemd/user/aicoder-opencode-monitor.service`

```ini
[Unit]
Description=aicoder-opencode OpenPortal Monitoring Service
After=aicoder-opencode-openportal.service
Requires=aicoder-opencode-openportal.service

[Service]
Environment=NODE_ENV=production
Environment=OPENCODE_MONITOR_PORT=3092
ExecStart=/home/mhugo/.npm-global/bin/opencode-monitor start
Restart=always
RestartSec=5
User=%i

[Install]
WantedBy=default.target
```

### Control Plane Integration

```typescript
// In control plane initialization
async function initializeControlPlane() {
  // Start core services
  const openPortal = new OpenPortalService();
  const openCodeServer = new OpenCodeServer();
  
  // Start monitoring service
  const monitor = new OpenPortalMonitor();
  monitor.start();
  
  // Integrate monitoring with core services
  openPortal.on('request', (req) => monitor.trackRequest(req));
  openCodeServer.on('operation', (op) => monitor.trackOperation(op));
  
  // Health check endpoint
  openPortal.addEndpoint('/health', async (req, res) => {
    const health = await monitor.getCurrentHealth();
    res.json(health);
  });
  
  // Alerts endpoint
  openPortal.addEndpoint('/alerts', async (req, res) => {
    const alerts = monitor.getActiveAlerts();
    res.json(alerts);
  });
}
```

## Performance Optimization

### Optimization Strategies

**1. Efficient Health Checks:**
- Cache health check results (30s TTL)
- Parallel component checks
- Lazy evaluation of expensive checks
- Incremental health updates

**2. Metrics Optimization:**
- Sampling for high-frequency metrics
- Aggregation before storage
- Compression for historical data
- Efficient time-series storage

**3. Alerting Optimization:**
- Alert debouncing
- Cooldown periods
- Alert correlation
- Batch notifications

**4. Dashboard Optimization:**
- Client-side rendering
- Data sampling for large datasets
- Lazy loading of details
- WebSocket updates for real-time data

### Performance Targets

**Monitoring Overhead:**
- <5% CPU utilization
- <50MB memory usage
- <100ms health check time
- <500ms full metrics collection

**System Impact:**
- <1% impact on OpenPortal performance
- <2% impact on OpenCode operations
- No impact on target operations

## Security Considerations

### Monitoring Security

**Access Control:**
- Read-only access for most users
- Admin access for configuration changes
- Audit logging for all monitoring actions
- Role-based access to sensitive metrics

**Data Protection:**
- No storage of sensitive operation data
- Redaction of secrets in logs
- Encrypted alert notifications
- Secure API endpoints

### Failure Modes

**Monitoring Failure Handling:**
- Graceful degradation
- Fallback to basic health checks
- Alert on monitoring system failure
- Automatic restart capability

**Alert Storm Protection:**
- Rate limiting
- Alert correlation
- Cooldown periods
- Manual override capability

## Success Criteria

### Technical Success:
- 99.9% monitoring uptime
- <1s health check response time
- <5s alert delivery time for critical issues
- 0 false negatives for critical alerts
- <5% false positives overall

### Operational Success:
- Proactive issue detection before user impact
- Reduced mean time to detect (MTTD) by >50%
- Improved mean time to resolve (MTTR) by >30%
- Comprehensive visibility into control plane health
- Team confidence in monitoring system

### Business Success:
- Reduced control plane downtime
- Improved target operation reliability
- Better resource utilization
- Data-driven capacity planning
- Measurable improvement in system stability

## Implementation Plan

### Phase 1: Core Monitoring (2 weeks)

**Tasks:**
- [ ] Implement health check framework
- [ ] Create basic metrics collection
- [ ] Build alerting engine
- [ ] Develop notification system
- [ ] Create simple dashboard

**Deliverables:**
- Functional health monitoring
- Basic alerting capability
- Simple web dashboard
- Systemd service integration

### Phase 2: Advanced Features (2 weeks)

**Tasks:**
- [ ] Implement detailed metrics collection
- [ ] Add historical data storage
- [ ] Develop advanced alerting rules
- [ ] Create comprehensive dashboard
- [ ] Add target-specific monitoring

**Deliverables:**
- Complete metrics system
- Advanced alerting with cooldowns
- Full-featured dashboard
- Target health integration

### Phase 3: Integration & Optimization (1 week)

**Tasks:**
- [ ] Integrate with control plane
- [ ] Add API endpoints
- [ ] Performance optimization
- [ ] Load testing
- [ ] Documentation completion

**Deliverables:**
- Fully integrated monitoring
- Production-ready performance
- Complete documentation
- Tested and validated system

## Timeline

```
Week 1-2: Core Monitoring (Health Checks, Basic Alerting)
Week 3-4: Advanced Features (Metrics, Dashboard, Target Integration)
Week 5:   Integration & Optimization
```

**Total Estimated Time:** 5 weeks
**Team Required:** 1 engineer (part-time)
**Resources:** Minimal (existing control plane infrastructure)

## Approval & Next Steps

**Required Approvals:**
- [ ] Control Plane Architect
- [ ] Infrastructure Team
- [ ] Security Review

**Next Steps:**
1. Implement health check framework
2. Create basic metrics collection
3. Build alerting engine
4. Develop notification system
5. Create simple dashboard
6. Integrate with control plane
7. Test and optimize
8. Deploy to production
9. Monitor and refine
