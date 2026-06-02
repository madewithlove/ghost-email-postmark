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

    // Postmark batch API supports up to 500 recipients per request
    static BATCH_SIZE = 500;

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
                    MessageStream: postmarkConfig.messageStream || 'outbound'
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

                // Add metadata for tracking
                if (message.id) {
                    emailData.Metadata = {
                        'email-id': message.id
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
        let offset = 0;
        const count = 500; // Maximum per request

        try {
            while (eventCount < maxEvents) {
                const batchStartTime = Date.now();

                // Fetch batch of messages
                const response = await this.#makePostmarkRequest(
                    `/messages/outbound?count=${count}&offset=${offset}&${new URLSearchParams(postmarkOptions).toString()}`,
                    null,
                    postmarkConfig,
                    'GET'
                );

                if (!response.Messages || response.Messages.length === 0) {
                    break; // No more messages
                }

                // Get detailed events for each message
                const events = [];
                for (const message of response.Messages) {
                    try {
                        const details = await this.#makePostmarkRequest(
                            `/messages/outbound/${message.MessageID}/details`,
                            null,
                            postmarkConfig,
                            'GET'
                        );

                        if (details.MessageEvents) {
                            // Convert Postmark events to Ghost format
                            for (const event of details.MessageEvents) {
                                const normalizedEvent = this.normalizeEvent(event, message);
                                if (normalizedEvent && normalizedEvent.timestamp <= startDate) {
                                    events.push(normalizedEvent);
                                }
                            }
                        }
                    } catch (error) {
                        logging.error(`[PostmarkClient] Error fetching message details for ${message.MessageID}: ${error.message}`);
                        // Continue with next message
                    }
                }

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

                // Postmark limits to 10,000 messages per search
                if (offset >= 10000) {
                    logging.warn('[PostmarkClient] Reached Postmark pagination limit of 10,000 messages');
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
     * Normalize Postmark event to Ghost format
     *
     * @param {Object} event - Postmark event
     * @param {Object} message - Postmark message
     * @returns {Object|null} Normalized event
     */
    normalizeEvent(event, message) {
        if (!event || !event.Type) {
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
            id: event.MessageID || message.MessageID,
            type: ghostEventType,
            severity: event.Type === 'Bounced' ? 'permanent' : null,
            recipientEmail: event.Recipient || message.Recipients?.[0],
            emailId: message.Metadata?.['email-id'],
            providerId: message.MessageID,
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
            }

            const response = await fetch(url, options);
            const data = await response.json();

            if (!response.ok) {
                throw new errors.EmailError({
                    statusCode: response.status,
                    message: data.Message || 'Postmark API Error',
                    errorDetails: JSON.stringify(data),
                    context: `Postmark Error ${response.status}: ${data.Message || 'Unknown error'}`,
                    code: 'POSTMARK_API_ERROR'
                });
            }

            return data;
        } catch (error) {
            // Re-throw if already a Ghost error
            if (error.code) {
                throw error;
            }

            // Wrap network errors
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
