const debug = require('@tryghost/debug');
const logging = require('@tryghost/logging');
const metrics = require('@tryghost/metrics');
const errors = require('@tryghost/errors');

/**
 * Postmark Client
 *
 * Handles communication with Postmark's traditional and Bulk Email APIs.
 * Implements fallback logic: attempts Bulk API first, falls back to traditional API on failure.
 */
module.exports = class PostmarkClient {
    #config;
    #settings;

    // Reduced from 500 to 100 to prevent payload size issues
    // At 500 recipients, payloads were reaching 56MB which caused timeouts
    // 100 recipients results in ~11MB payloads which is more manageable
    static BATCH_SIZE = 100;

    constructor({config, settings}) {
        this.#config = config;
        this.#settings = settings;
    }

    /**
     * Send emails using Postmark batch API
     *
     * @param {Object} message - Message data
     * @param {string} message.subject - Email subject
     * @param {string} message.html - HTML content
     * @param {string} message.plaintext - Plain text content
     * @param {string} message.from - From email address
     * @param {string} [message.replyTo] - Reply-to email address
     * @param {string} [message.id] - Email ID for tracking
     * @param {boolean} [message.track_opens] - Enable open tracking
     * @param {boolean} [message.track_clicks] - Enable click tracking
     * @param {Date} [message.deliveryTime] - Scheduled delivery time
     * @param {string} [message.domainOverride] - Override domain (not used for Postmark)
     * @param {Object} recipientData - Recipient variables for personalization
     * @param {Array<Object>} replacements - Replacement definitions
     *
     * @returns {Promise<{id: string}>}
     */
    async send(message, recipientData, replacements) {
        const postmarkConfig = this.#getConfig();
        if (!postmarkConfig) {
            logging.warn('Postmark is not configured');
            return null;
        }

        const batchSize = this.getBatchSize();
        const recipients = Object.keys(recipientData);

        if (recipients.length > batchSize) {
            throw new errors.IncorrectUsageError({
                message: `Postmark only supports sending to ${batchSize} recipients at a time`
            });
        }

        return await this.#sendViaBatchApi(message, recipientData, replacements, postmarkConfig);
    }

    /**
     * Send via Postmark batch API
     *
     * @private
     */
    async #sendViaBatchApi(message, recipientData, replacements, postmarkConfig) {
        const startTime = Date.now();

        try {
            const recipients = Object.keys(recipientData);
            debug(`[PostmarkClient] Sending via traditional API to ${recipients.length} recipients`);

            // For traditional API, we need to send individual emails
            // But we can batch them using Postmark's batch endpoint
            const emails = recipients.map((email) => {
                const emailData = {
                    From: message.from,
                    To: email,
                    Subject: message.subject,
                    HtmlBody: message.html,
                    MessageStream: postmarkConfig.messageStream || 'broadcast'
                };

                if (message.plaintext) {
                    emailData.TextBody = message.plaintext;
                }

                if (message.replyTo) {
                    emailData.ReplyTo = message.replyTo;
                }

                if (message.track_opens) {
                    emailData.TrackOpens = true;
                }

                if (message.track_clicks) {
                    emailData.TrackLinks = 'HtmlAndText';
                }

                // Add metadata and tag for tracking
                // IMPORTANT: Postmark's events APIs (opens, clicks, bounces) do NOT return Metadata,
                // but they DO return Tag. So we put email-id in both places:
                // - Metadata: for message details API (legacy)
                // - Tag: for events APIs (opens, clicks, bounces) - this is what we actually use
                // Format: ghost-email|{email-id} to match Ghost's convention
                if (message.id) {
                    emailData.Tag = `ghost-email|${message.id}`; // Used by events APIs
                    emailData.Metadata = {
                        'email-id': message.id  // Used by message details API
                    };
                }

                // Apply recipient-specific replacements
                const recipientReplacements = recipientData[email];
                let htmlBody = emailData.HtmlBody;
                let textBody = emailData.TextBody;

                replacements.forEach((replacement) => {
                    const value = recipientReplacements[replacement.id];
                    if (value !== undefined) {
                        htmlBody = htmlBody.replace(replacement.regexp, value);
                        if (textBody) {
                            textBody = textBody.replace(replacement.regexp, value);
                        }
                    }
                });

                emailData.HtmlBody = htmlBody;
                if (textBody) {
                    emailData.TextBody = textBody;
                }

                // Add custom headers
                emailData.Headers = [
                    {Name: 'X-Auto-Response-Suppress', Value: 'OOF, AutoReply'}
                ];

                // Scheduled delivery (only supported in traditional API)
                if (message.deliveryTime && message.deliveryTime instanceof Date) {
                    // Postmark doesn't natively support scheduled sends
                    // This would need to be handled at the Ghost level
                    logging.warn('[PostmarkClient] Scheduled delivery not natively supported by Postmark');
                }

                return emailData;
            });

            // Use batch endpoint for multiple recipients
            const endpoint = emails.length > 1 ? '/email/batch' : '/email';
            const payload = emails.length > 1 ? emails : emails[0];

            const response = await this.#makePostmarkRequest(
                endpoint,
                payload,
                postmarkConfig,
                'POST'
            );

            metrics.metric('postmark-send-mail', {
                value: Date.now() - startTime,
                statusCode: 200
            });

            logging.info(`[PostmarkClient] Sent via traditional API (${Date.now() - startTime}ms)`);

            // Extract message ID from response
            const messageId = Array.isArray(response)
                ? response[0]?.MessageID
                : response.MessageID;

            return {
                id: messageId || `traditional-${Date.now()}`
            };
        } catch (error) {
            metrics.metric('postmark-send-mail', {
                value: Date.now() - startTime,
                statusCode: error.statusCode || 500
            });
            throw error;
        }
    }

    /**
     * Get Postmark configuration from config or settings
     *
     * @returns {Object|null}
     * @private
     */
    #getConfig() {
        // Prefer unified adapter config at adapters.email.ghost-email-postmark
        const emailAdapterConfig = this.#config.get('adapters:email');
        if (emailAdapterConfig?.['ghost-email-postmark']) {
            return emailAdapterConfig['ghost-email-postmark'];
        }

        // Fall back to legacy bulkEmail.postmark for backward compatibility
        const bulkEmailConfig = this.#config.get('bulkEmail');
        if (bulkEmailConfig?.postmark) {
            return bulkEmailConfig.postmark;
        }

        return null;
    }

    /**
     * Check if Postmark is configured
     *
     * @returns {boolean}
     */
    isConfigured() {
        const config = this.#getConfig();
        return !!(config && config.serverToken);
    }

    /**
     * Get configured batch size
     *
     * @returns {number}
     */
    getBatchSize() {
        return PostmarkClient.BATCH_SIZE;
    }

    /**
     * Get target delivery window in milliseconds
     *
     * @returns {number}
     */
    getTargetDeliveryWindow() {
        const targetDeliveryWindow = this.#config.get('bulkEmail')?.targetDeliveryWindow;

        if (targetDeliveryWindow === undefined || !Number.isInteger(parseInt(targetDeliveryWindow)) || parseInt(targetDeliveryWindow) < 0) {
            return 0;
        }

        return parseInt(targetDeliveryWindow);
    }

    /**
     * Fetch message events from Postmark for analytics
     *
     * @param {Object} postmarkOptions - Search options
     * @param {Function} batchHandler - Handler for processing event batches
     * @param {Object} options - Additional options
     * @param {number} [options.maxEvents] - Maximum events to fetch
     * @returns {Promise<void>}
     */
    async fetchEvents(postmarkOptions, batchHandler, {maxEvents = Infinity} = {}) {
        const postmarkConfig = this.#getConfig();
        if (!postmarkConfig) {
            logging.warn('[PostmarkClient] Postmark is not configured');
            return;
        }

        const startDate = new Date();
        const overallStartTime = Date.now();

        let batchCount = 0;
        let totalBatchTime = 0;
        let eventCount = 0;

        try {
            // Fetch different event types using dedicated endpoints
            // This is much more efficient than fetching message details for each message
            const eventEndpoints = [
                {type: 'opens', endpoint: '/messages/outbound/opens'},
                {type: 'clicks', endpoint: '/messages/outbound/clicks'},
                {type: 'bounces', endpoint: '/bounces'}
            ];

            for (const {type, endpoint} of eventEndpoints) {
                let offset = 0;
                const count = 500; // Maximum per request

                while (eventCount < maxEvents) {
                    const batchStartTime = Date.now();

                    // Build query parameters
                    const params = new URLSearchParams({
                        count: count.toString(),
                        offset: offset.toString(),
                        ...postmarkOptions
                    });

                    // Fetch batch of events
                    const response = await this.#makePostmarkRequest(
                        `${endpoint}?${params.toString()}`,
                        null,
                        postmarkConfig,
                        'GET'
                    );

                    // Different response formats for different endpoints
                    let items = [];
                    if (type === 'bounces') {
                        items = response.Bounces || [];
                    } else if (type === 'opens') {
                        items = response.Opens || [];
                    } else if (type === 'clicks') {
                        items = response.Clicks || [];
                    }

                    if (items.length === 0) {
                        break; // No more events of this type
                    }

                    // Convert events to Ghost format
                    const events = items
                        .map(event => this.normalizeEvent(event, null, type))
                        .filter(event => event && event.timestamp <= startDate);

                    if (events.length > 0) {
                        await batchHandler(events);
                    }

                    const batchEndTime = Date.now();
                    const batchDuration = batchEndTime - batchStartTime;

                    batchCount += 1;
                    totalBatchTime += batchDuration;
                    eventCount += events.length;

                    // Check if we've reached maxEvents
                    if (eventCount >= maxEvents) {
                        break;
                    }

                    // Move to next page
                    offset += count;

                    // Postmark limits to 10,000 events per search
                    if (offset >= 10000) {
                        logging.warn(`[PostmarkClient] Reached Postmark pagination limit for ${type}`);
                        break;
                    }
                }

                // Check if we've reached maxEvents across all event types
                if (eventCount >= maxEvents) {
                    break;
                }
            }

            const overallEndTime = Date.now();
            const totalDuration = overallEndTime - overallStartTime;
            const averageBatchTime = batchCount > 0 ? totalBatchTime / batchCount : 0;

            logging.info(`[PostmarkClient] Processed ${batchCount} batches in ${(totalDuration / 1000).toFixed(2)}s. Average batch time: ${(averageBatchTime / 1000).toFixed(2)}s`);
        } catch (error) {
            logging.error('[PostmarkClient] Error fetching events');
            logging.error(error);
            throw error;
        }
    }

    /**
     * Extract email ID from Postmark tag
     * Tag format: ghost-email|{email-id}
     *
     * @param {string} tag - Postmark tag
     * @returns {string|null} Email ID or null
     * @private
     */
    #extractEmailIdFromTag(tag) {
        if (!tag) {
            return null;
        }

        // Tag format: ghost-email|{email-id}
        const match = tag.match(/^ghost-email\|(.+)$/);
        if (match && match[1]) {
            return match[1];
        }

        return null;
    }

    /**
     * Normalize Postmark event to Ghost format
     *
     * @param {Object} event - Postmark event
     * @param {Object} message - Postmark message (optional, used for old format)
     * @param {string} eventType - Event type from endpoint (opens, clicks, bounces)
     * @returns {Object|null} Normalized event
     */
    normalizeEvent(event, message = null, eventType = null) {
        if (!event) {
            logging.error('[PostmarkClient] Received invalid event from Postmark');
            return null;
        }

        // Handle events from dedicated endpoints (opens, clicks, bounces)
        if (eventType) {
            let ghostEventType;
            let timestamp;
            let recipientEmail;
            let messageId;
            let emailId;

            if (eventType === 'opens') {
                ghostEventType = 'opened';
                timestamp = new Date(event.ReceivedAt || event.FirstOpen);
                recipientEmail = event.Recipient;
                messageId = event.MessageID;
                // Postmark opens API does NOT return Metadata, only Tag
                // Tag format: ghost-email|{email-id}
                emailId = this.#extractEmailIdFromTag(event.Tag) || event.Metadata?.['email-id'];
            } else if (eventType === 'clicks') {
                ghostEventType = 'clicked';
                timestamp = new Date(event.ReceivedAt);
                recipientEmail = event.Recipient;
                messageId = event.MessageID;
                // Postmark clicks API does NOT return Metadata, only Tag
                // Tag format: ghost-email|{email-id}
                emailId = this.#extractEmailIdFromTag(event.Tag) || event.Metadata?.['email-id'];
            } else if (eventType === 'bounces') {
                ghostEventType = 'failed';
                timestamp = new Date(event.BouncedAt);
                recipientEmail = event.Email;
                messageId = event.MessageID;
                // Postmark bounces API does NOT return Metadata, only Tag
                // Tag format: ghost-email|{email-id}
                emailId = this.#extractEmailIdFromTag(event.Tag) || event.Metadata?.['email-id'];
            }

            // Log if emailId is missing to debug
            if (!emailId) {
                logging.warn(`[PostmarkClient] Missing email-id for ${eventType} event. MessageID: ${messageId}, checking event structure`);
                debug(`Event structure: ${JSON.stringify(event)}`);
            }

            const normalizedEvent = {
                id: messageId,
                type: ghostEventType,
                severity: eventType === 'bounces' ? (event.Type === 'HardBounce' ? 'permanent' : 'temporary') : null,
                recipientEmail: recipientEmail,
                emailId: emailId,
                providerId: messageId,
                timestamp: timestamp
            };

            // Add error details for bounces
            if (eventType === 'bounces') {
                normalizedEvent.error = {
                    code: event.ID,
                    message: (event.Description || 'Bounce').substring(0, 2000),
                    enhancedCode: event.Type?.substring(0, 50) || null
                };
            }

            return normalizedEvent;
        }

        // Handle events from message details endpoint (old format)
        if (!event.Type) {
            logging.error('[PostmarkClient] Received invalid event from Postmark');
            logging.error(event);
            return null;
        }

        // Map Postmark event types to Ghost event types
        const eventTypeMap = {
            'Delivered': 'delivered',
            'Bounced': 'failed',
            'Opened': 'opened',
            'LinkClicked': 'clicked',
            'SpamComplaint': 'complained',
            'SubscriptionChange': 'unsubscribed'
        };

        const ghostEventType = eventTypeMap[event.Type];
        if (!ghostEventType) {
            // Skip unknown event types
            return null;
        }

        const normalizedEvent = {
            id: event.MessageID || message?.MessageID,
            type: ghostEventType,
            severity: event.Type === 'Bounced' ? 'permanent' : null,
            recipientEmail: event.Recipient || message?.Recipients?.[0],
            emailId: message?.Metadata?.['email-id'],
            providerId: message?.MessageID,
            timestamp: new Date(event.ReceivedAt)
        };

        // Add error details for bounces
        if (event.Type === 'Bounced' && event.Details) {
            normalizedEvent.error = {
                code: event.Details.BounceID,
                message: (event.Details.Summary || event.Details.Description || 'Bounce').substring(0, 2000),
                enhancedCode: event.Details.Type?.substring(0, 50) || null
            };
        }

        return normalizedEvent;
    }

    /**
     * Make authenticated request to Postmark API
     *
     * @param {string} endpoint - API endpoint
     * @param {Object|null} payload - Request payload (null for GET)
     * @param {Object} config - Postmark config
     * @param {string} method - HTTP method
     * @returns {Promise<Object>}
     * @private
     */
    async #makePostmarkRequest(endpoint, payload, config, method = 'POST') {
        const url = `${config.apiUrl || 'https://api.postmarkapp.com'}${endpoint}`;

        logging.info(`[PostmarkClient] Making ${method} request to ${endpoint}`);

        try {
            const options = {
                method,
                headers: {
                    'Accept': 'application/json',
                    'X-Postmark-Server-Token': config.serverToken
                }
            };

            if (method === 'POST' && payload) {
                options.headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(payload);
                logging.info(`[PostmarkClient] Payload size: ${JSON.stringify(payload).length} bytes, recipients: ${Array.isArray(payload) ? payload.length : 1}`);
            }

            logging.info(`[PostmarkClient] Sending request to ${url}`);

            // Add timeout to prevent hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            options.signal = controller.signal;

            let response;
            try {
                response = await fetch(url, options);
                clearTimeout(timeoutId);
                logging.info(`[PostmarkClient] Response received with status: ${response.status}`);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    logging.error(`[PostmarkClient] Request timed out after 30 seconds`);
                    throw new Error('Postmark API request timed out after 30 seconds');
                }
                logging.error(`[PostmarkClient] Fetch failed: ${fetchError.message}`);
                throw fetchError;
            }

            if (!response.ok) {
                // Handle rate limiting (429) - response may not be JSON
                if (response.status === 429) {
                    logging.warn(`[PostmarkClient] Rate limited by Postmark API (429)`);
                    throw new errors.EmailError({
                        statusCode: 429,
                        message: 'Postmark API rate limit exceeded',
                        errorDetails: 'Too many requests',
                        context: 'Postmark Rate Limit',
                        code: 'POSTMARK_RATE_LIMIT'
                    });
                }

                // Try to parse JSON for other errors
                let data;
                try {
                    data = await response.json();
                } catch (e) {
                    // Response is not JSON
                    throw new errors.EmailError({
                        statusCode: response.status,
                        message: 'Postmark API Error (non-JSON response)',
                        errorDetails: response.statusText,
                        context: `Postmark Error ${response.status}`,
                        code: 'POSTMARK_API_ERROR'
                    });
                }

                logging.error(`[PostmarkClient] Postmark API error ${response.status}: ${data.Message || 'Unknown'}`);
                logging.error(`[PostmarkClient] Error details: ${JSON.stringify(data)}`);
                throw new errors.EmailError({
                    statusCode: response.status,
                    message: data.Message || 'Postmark API Error',
                    errorDetails: JSON.stringify(data),
                    context: `Postmark Error ${response.status}: ${data.Message || 'Unknown error'}`,
                    code: 'POSTMARK_API_ERROR'
                });
            }

            const data = await response.json();
            logging.info(`[PostmarkClient] Response parsed successfully`);

            logging.info(`[PostmarkClient] Request completed successfully`);
            return data;
        } catch (error) {
            logging.error(`[PostmarkClient] Exception caught: ${error.message}`);
            logging.error(`[PostmarkClient] Error code: ${error.code || 'none'}`);
            logging.error(`[PostmarkClient] Stack trace: ${error.stack}`);

            // Re-throw if already a Ghost error
            if (error.code) {
                logging.error(`[PostmarkClient] Re-throwing Ghost error with code: ${error.code}`);
                throw error;
            }

            // Wrap network errors
            logging.error(`[PostmarkClient] Wrapping as network error`);
            throw new errors.EmailError({
                statusCode: 500,
                message: error.message || 'Failed to communicate with Postmark API',
                errorDetails: error.stack,
                context: 'Postmark Network Error',
                code: 'POSTMARK_NETWORK_ERROR'
            });
        }
    }
};
