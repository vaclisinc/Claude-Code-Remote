/**
 * Email Notification Channel
 * Sends notifications via email with reply support
 */

const NotificationChannel = require('../base/channel');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class EmailChannel extends NotificationChannel {
    constructor(config = {}) {
        super('email', config);
        this.transporter = null;
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.templatesDir = path.join(__dirname, '../../assets/email-templates');
        this.sentMessagesPath = config.sentMessagesPath || path.join(__dirname, '../../data/sent-messages.json');
        this.tmuxMonitor = new TmuxMonitor();
        
        this._ensureDirectories();
        this._initializeTransporter();
    }

    _escapeHtml(text) {
        if (!text) return '';
        const htmlEntities = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return text.replace(/[&<>"']/g, char => htmlEntities[char]);
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
        if (!fs.existsSync(this.templatesDir)) {
            fs.mkdirSync(this.templatesDir, { recursive: true });
        }
    }

    _generateToken() {
        // Generate short Token (uppercase letters + numbers, 8 digits)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }

    _initializeTransporter() {
        if (!this.config.smtp) {
            this.logger.warn('SMTP configuration not found');
            return;
        }

        try {
            this.transporter = nodemailer.createTransport({
                host: this.config.smtp.host,
                port: this.config.smtp.port,
                secure: this.config.smtp.secure || false,
                auth: {
                    user: this.config.smtp.auth.user,
                    pass: this.config.smtp.auth.pass
                },
                // Add timeout settings
                connectionTimeout: parseInt(process.env.SMTP_TIMEOUT) || 10000,
                greetingTimeout: parseInt(process.env.SMTP_TIMEOUT) || 10000,
                socketTimeout: parseInt(process.env.SMTP_TIMEOUT) || 10000
            });

            this.logger.debug('Email transporter initialized');
        } catch (error) {
            this.logger.error('Failed to initialize email transporter:', error.message);
        }
    }

    _getCurrentTmuxSession() {
        try {
            // Try to get current tmux session
            const tmuxSession = execSync('tmux display-message -p "#S"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            
            return tmuxSession || null;
        } catch (error) {
            // Not in a tmux session or tmux not available
            return null;
        }
    }

    async _sendImpl(notification) {
        if (!this.transporter) {
            throw new Error('Email transporter not initialized');
        }

        if (!this.config.to) {
            throw new Error('Email recipient not configured');
        }

        // Generate session ID and Token
        const sessionId = uuidv4();
        const token = this._generateToken();
        
        // Get current tmux session and conversation content
        const tmuxSession = this._getCurrentTmuxSession();
        if (tmuxSession && !notification.metadata) {
            const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
            notification.metadata = {
                userQuestion: conversation.userQuestion || notification.message,
                claudeResponse: conversation.claudeResponse || notification.message,
                tmuxSession: tmuxSession
            };
        }
        
        // Create session record
        await this._createSession(sessionId, notification, token);

        // Generate email content
        const emailContent = this._generateEmailContent(notification, sessionId, token);
        
        // Generate unique Message-ID
        const messageId = `<${sessionId}-${Date.now()}@claude-code-remote>`;
        
        const mailOptions = {
            from: this.config.from || this.config.smtp.auth.user,
            to: this.config.to,
            subject: emailContent.subject,
            html: emailContent.html,
            text: emailContent.text,
            messageId: messageId,
            // Add custom headers for reply recognition
            headers: {
                'X-Claude-Code-Remote-Session-ID': sessionId,
                'X-Claude-Code-Remote-Type': notification.type
            }
        };

        try {
            const result = await this.transporter.sendMail(mailOptions);
            this.logger.info(`Email sent successfully to ${this.config.to}, Session: ${sessionId}`);
            
            // Track sent message
            await this._trackSentMessage(messageId, sessionId, token);
            
            return true;
        } catch (error) {
            this.logger.error('Failed to send email:', error.message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'pty',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Expires after 24 hours
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            cwd: process.cwd(),
            notification: {
                type: notification.type,
                project: notification.project,
                message: notification.message
            },
            status: 'waiting',
            commandCount: 0,
            maxCommands: 10
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        // Also save in PTY mapping format
        const sessionMapPath = process.env.SESSION_MAP_PATH || path.join(__dirname, '../../data/session-map.json');
        let sessionMap = {};
        if (fs.existsSync(sessionMapPath)) {
            try {
                sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
            } catch (e) {
                sessionMap = {};
            }
        }
        
        // Use passed tmux session name or detect current session
        let tmuxSession = notification.metadata?.tmuxSession || this._getCurrentTmuxSession() || 'claude-code-remote';
        
        sessionMap[token] = {
            type: 'pty',
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            cwd: process.cwd(),
            sessionId: sessionId,
            tmuxSession: tmuxSession,
            description: `${notification.type} - ${notification.project}`
        };
        
        // Ensure directory exists
        const mapDir = path.dirname(sessionMapPath);
        if (!fs.existsSync(mapDir)) {
            fs.mkdirSync(mapDir, { recursive: true });
        }
        
        fs.writeFileSync(sessionMapPath, JSON.stringify(sessionMap, null, 2));
        
        this.logger.debug(`Session created: ${sessionId}, Token: ${token}`);
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    async _trackSentMessage(messageId, sessionId, token) {
        let sentMessages = { messages: [] };
        
        // Read existing data if file exists
        if (fs.existsSync(this.sentMessagesPath)) {
            try {
                sentMessages = JSON.parse(fs.readFileSync(this.sentMessagesPath, 'utf8'));
            } catch (e) {
                this.logger.warn('Failed to read sent-messages.json, creating new one');
            }
        }
        
        // Add new message
        sentMessages.messages.push({
            messageId: messageId,
            sessionId: sessionId,
            token: token,
            type: 'notification',
            sentAt: new Date().toISOString()
        });
        
        // Ensure directory exists
        const dir = path.dirname(this.sentMessagesPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write updated data
        fs.writeFileSync(this.sentMessagesPath, JSON.stringify(sentMessages, null, 2));
        this.logger.debug(`Tracked sent message: ${messageId}`);
    }

    _generateEmailContent(notification, sessionId, token) {
        const template = this._getTemplate(notification.type);
        const timestamp = new Date().toLocaleString('zh-CN');
        
        // Get project directory name (last level directory)
        const projectDir = path.basename(process.cwd());
        
        // Extract user question (from notification.metadata if available)
        let userQuestion = '';
        let claudeResponse = '';
        
        if (notification.metadata) {
            userQuestion = notification.metadata.userQuestion || '';
            claudeResponse = notification.metadata.claudeResponse || '';
        }
        
        // Limit user question length for title
        const maxQuestionLength = 30;
        const shortQuestion = userQuestion.length > maxQuestionLength ? 
            userQuestion.substring(0, maxQuestionLength) + '...' : userQuestion;
        
        // Generate more distinctive title
        let enhancedSubject = template.subject;
        if (shortQuestion) {
            enhancedSubject = enhancedSubject.replace('{{project}}', `${projectDir} | ${shortQuestion}`);
        } else {
            enhancedSubject = enhancedSubject.replace('{{project}}', projectDir);
        }
        
        // Template variable replacement
        const variables = {
            project: projectDir,
            message: notification.message,
            timestamp: timestamp,
            sessionId: sessionId,
            token: token,
            type: notification.type === 'completed' ? 'Task completed' : 'Waiting for input',
            userQuestion: userQuestion || 'No specified task',
            claudeResponse: claudeResponse || notification.message,
            projectDir: projectDir,
            shortQuestion: shortQuestion || 'No specific question',
            subagentActivities: notification.metadata?.subagentActivities || ''
        };

        let subject = enhancedSubject;
        let html = template.html;
        let text = template.text;

        // Replace template variables
        Object.keys(variables).forEach(key => {
            const placeholder = new RegExp(`{{${key}}}`, 'g');
            subject = subject.replace(placeholder, variables[key]);
            // Escape HTML entities for HTML content
            html = html.replace(placeholder, this._escapeHtml(variables[key]));
            // No escaping needed for plain text
            text = text.replace(placeholder, variables[key]);
        });

        return { subject, html, text };
    }

    _getTemplate(type) {
        // Default templates
        const templates = {
            completed: {
                subject: '[Claude-Code-Remote #{{token}}] Claude Code Task Completed - {{project}}',
                html: `
                <div style="font-family: 'Consolas', 'Monaco', 'Courier New', monospace; background-color: #f5f5f5; padding: 0; margin: 0;">
                    <div style="max-width: 900px; margin: 0 auto; background-color: #1e1e1e; border: 1px solid #333; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);">
                        <!-- Terminal Header -->
                        <div style="background-color: #2d2d2d; padding: 10px 15px; border-bottom: 1px solid #444;">
                            <table style="display: inline-table; vertical-align: middle;" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="padding: 0;"><div style="width: 12px; height: 12px; border-radius: 50%; background-color: #ff5f56;"></div></td>
                                    <td style="padding: 0 0 0 5px;"><div style="width: 12px; height: 12px; border-radius: 50%; background-color: #ffbd2e;"></div></td>
                                    <td style="padding: 0 0 0 5px;"><div style="width: 12px; height: 12px; border-radius: 50%; background-color: #27c93f;"></div></td>
                                    <td style="padding: 0 0 0 12px; color: #999; font-size: 14px; white-space: nowrap;">claude-code-remote@{{project}} - Task Completed</td>
                                </tr>
                            </table>
                        </div>
                        
                        <!-- Terminal Content -->
                        <div style="padding: 20px; background-color: #1a1a1a; min-height: 400px;">
                            <!-- Session Info -->
                            <div style="color: #00ff00; margin-bottom: 20px;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">claude-code status</span><br>
                                <div style="margin-left: 20px; margin-top: 5px; color: #ccc;">
                                    <span style="color: #ff9800;">PROJECT:</span> {{projectDir}}<br>
                                    <span style="color: #ff9800;">SESSION:</span> #{{token}}<br>
                                    <span style="color: #ff9800;">STATUS:</span> <span style="color: #00ff00;">✓ Task Completed</span><br>
                                    <span style="color: #ff9800;">TIME:</span> {{timestamp}}
                                </div>
                            </div>
                            
                            <!-- User Input -->
                            <div style="margin: 20px 0;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">cat user_input.txt</span><br>
                                <div style="background-color: #262626; border-left: 3px solid #ff9800; padding: 10px 15px; margin: 10px 0; color: #f0f0f0; white-space: pre-wrap; word-wrap: break-word;">{{userQuestion}}</div>
                            </div>
                            
                            <!-- Claude Response -->
                            <div style="margin: 20px 0;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">claude-code execute</span><br>
                                <div style="color: #999; margin: 5px 0;">
                                    <span style="color: #00bcd4;">[INFO]</span> Processing request...<br>
                                    <span style="color: #00bcd4;">[INFO]</span> Executing task...
                                </div>
                                <div style="background-color: #262626; border-left: 3px solid #00ff00; padding: 15px; margin: 10px 0; color: #f0f0f0; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; font-size: 14px; line-height: 1.6;">{{claudeResponse}}</div>
                                <div style="color: #00ff00; margin-top: 10px;">
                                    <span style="color: #00bcd4;">[SUCCESS]</span> Task completed successfully ✓
                                </div>
                            </div>
                            
                            {{subagentActivities}}
                            
                            <!-- Continue Instructions -->
                            <div style="margin: 30px 0 20px 0; border-top: 1px solid #333; padding-top: 20px;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">claude-code help --continue</span><br>
                                <div style="color: #f0f0f0; margin: 10px 0;">
                                    <div style="color: #ff9800; margin-bottom: 10px;">→ TO CONTINUE THIS SESSION:</div>
                                    <div style="background-color: #262626; padding: 15px; border: 1px solid #333; margin: 10px 0;">
                                        Reply to this email directly with your next instruction.<br><br>
                                        <span style="color: #999;">Examples:</span><br>
                                        <span style="color: #00ff00;">  • "Add error handling to the function"</span><br>
                                        <span style="color: #00ff00;">  • "Write unit tests for this code"</span><br>
                                        <span style="color: #00ff00;">  • "Optimize the performance"</span>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Session Footer -->
                            <div style="color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
                                <span style="color: #999;">$</span> <span style="color: #666;">echo $SESSION_INFO</span><br>
                                <div style="margin-left: 20px; margin-top: 5px;">
                                    SESSION_ID={{sessionId}}<br>
                                    EXPIRES_IN=24h<br>
                                    SECURITY=Do not forward this email<br>
                                    POWERED_BY=Claude-Code-Remote
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                `,
                text: `
[Claude-Code-Remote #{{token}}] Claude Code Task Completed - {{projectDir}} | {{shortQuestion}}

Project: {{projectDir}}
Time: {{timestamp}}
Status: {{type}}

📝 Your Question:
{{userQuestion}}

🤖 Claude's Response:
{{claudeResponse}}

{{subagentActivities}}

How to Continue Conversation:
To continue conversation with Claude Code, please reply to this email directly and enter your instructions in the email body.

Example Replies:
• "Please continue optimizing the code"
• "Generate unit tests"  
• "Explain the purpose of this function"

Session ID: {{sessionId}}
Security Note: Please do not forward this email, session will automatically expire after 24 hours
                `
            },
            waiting: {
                subject: '[Claude-Code-Remote #{{token}}] Claude Code Waiting for Input - {{project}}',
                html: `
                <div style="font-family: 'Consolas', 'Monaco', 'Courier New', monospace; background-color: #f5f5f5; padding: 0; margin: 0;">
                    <div style="max-width: 900px; margin: 0 auto; background-color: #1e1e1e; border: 1px solid #333; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);">
                        <!-- Terminal Header -->
                        <div style="background-color: #2d2d2d; padding: 10px 15px; border-bottom: 1px solid #444;">
                            <table style="display: inline-table; vertical-align: middle;" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="padding: 0;"><div style="width: 12px; height: 12px; border-radius: 50%; background-color: #ff5f56;"></div></td>
                                    <td style="padding: 0 0 0 5px;"><div style="width: 12px; height: 12px; border-radius: 50%; background-color: #ffbd2e;"></div></td>
                                    <td style="padding: 0 0 0 5px;"><div style="width: 12px; height: 12px; border-radius: 50%; background-color: #27c93f;"></div></td>
                                    <td style="padding: 0 0 0 12px; color: #999; font-size: 14px; white-space: nowrap;">claude-code-remote@{{project}} - Waiting for Input</td>
                                </tr>
                            </table>
                        </div>
                        
                        <!-- Terminal Content -->
                        <div style="padding: 20px; background-color: #1a1a1a; min-height: 400px;">
                            <!-- Session Info -->
                            <div style="color: #00ff00; margin-bottom: 20px;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">claude-code status</span><br>
                                <div style="margin-left: 20px; margin-top: 5px; color: #ccc;">
                                    <span style="color: #ff9800;">PROJECT:</span> {{projectDir}}<br>
                                    <span style="color: #ff9800;">SESSION:</span> #{{token}}<br>
                                    <span style="color: #ff9800;">STATUS:</span> <span style="color: #ffeb3b;">⏳ Waiting for input</span><br>
                                    <span style="color: #ff9800;">TIME:</span> {{timestamp}}
                                </div>
                            </div>
                            
                            <!-- Waiting Message -->
                            <div style="margin: 20px 0;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">claude-code wait</span><br>
                                <div style="color: #ffeb3b; margin: 10px 0;">
                                    <span style="color: #ff9800;">[WAITING]</span> Claude needs your input to continue...<br>
                                </div>
                                <div style="background-color: #262626; border-left: 3px solid #ffeb3b; padding: 15px; margin: 10px 0; color: #f0f0f0;">
                                    {{message}}
                                </div>
                            </div>
                            
                            <!-- Continue Instructions -->
                            <div style="margin: 30px 0 20px 0; border-top: 1px solid #333; padding-top: 20px;">
                                <span style="color: #999;">$</span> <span style="color: #00ff00;">claude-code help --respond</span><br>
                                <div style="color: #f0f0f0; margin: 10px 0;">
                                    <div style="color: #ff9800; margin-bottom: 10px;">→ ACTION REQUIRED:</div>
                                    <div style="background-color: #262626; padding: 15px; border: 1px solid #333; margin: 10px 0;">
                                        <span style="color: #ffeb3b;">Claude is waiting for your guidance.</span><br><br>
                                        Reply to this email with your instructions to continue.
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Session Footer -->
                            <div style="color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333;">
                                <span style="color: #999;">$</span> <span style="color: #666;">echo $SESSION_INFO</span><br>
                                <div style="margin-left: 20px; margin-top: 5px;">
                                    SESSION_ID={{sessionId}}<br>
                                    EXPIRES_IN=24h<br>
                                    SECURITY=Do not forward this email<br>
                                    POWERED_BY=Claude-Code-Remote
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                `,
                text: `
[Claude-Code-Remote #{{token}}] Claude Code Waiting for Input - {{projectDir}}

Project: {{projectDir}}
Time: {{timestamp}}
Status: {{type}}

⏳ Waiting for Processing: {{message}}

Claude needs your further guidance. Please reply to this email to tell Claude what to do next.

Session ID: {{sessionId}}
Security Note: Please do not forward this email, session will automatically expire after 24 hours
                `
            }
        };

        return templates[type] || templates.completed;
    }

    validateConfig() {
        if (!this.config.smtp) {
            return { valid: false, error: 'SMTP configuration required' };
        }
        
        if (!this.config.smtp.host) {
            return { valid: false, error: 'SMTP host required' };
        }
        
        if (!this.config.smtp.auth || !this.config.smtp.auth.user || !this.config.smtp.auth.pass) {
            return { valid: false, error: 'SMTP authentication required' };
        }
        
        if (!this.config.to) {
            return { valid: false, error: 'Recipient email required' };
        }

        return { valid: true };
    }

    async test() {
        try {
            if (!this.transporter) {
                throw new Error('Email transporter not initialized');
            }

            // Verify SMTP connection
            await this.transporter.verify();
            
            // Send test email
            const testNotification = {
                type: 'completed',
                title: 'Claude-Code-Remote Test',
                message: 'This is a test email to verify that the email notification function is working properly.',
                project: 'Claude-Code-Remote-Test',
                metadata: {
                    test: true,
                    timestamp: new Date().toISOString()
                }
            };

            const result = await this._sendImpl(testNotification);
            return result;
        } catch (error) {
            this.logger.error('Email test failed:', error.message);
            return false;
        }
    }

    getStatus() {
        const baseStatus = super.getStatus();
        return {
            ...baseStatus,
            configured: this.validateConfig().valid,
            supportsRelay: true,
            smtp: {
                host: this.config.smtp?.host || 'not configured',
                port: this.config.smtp?.port || 'not configured',
                secure: this.config.smtp?.secure || false
            },
            recipient: this.config.to || 'not configured'
        };
    }
}

module.exports = EmailChannel;