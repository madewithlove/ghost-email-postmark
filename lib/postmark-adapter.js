const PostmarkClient = require('./postmark-client');

// Try to load EmailProviderBase if available (for Ghost integration)
let EmailProviderBase;
try {
    // When used as a Ghost adapter, extend from EmailProviderBase
    EmailProviderBase = require('../../core/server/adapters/email/EmailProviderBase');
} catch (e) {
    // Fallback for standalone usage - create a minimal base class
    EmailProviderBase = class {
        static requiredFns = ['send', 'getMaximumRecipients', 'getTargetDeliveryWindow', 'fetchLatest'];
        constructor(config) {
            this.config = config;
        }
    };
}

/**
 * Postmark Email Adapter
 *
 * Email adapter for Ghost that handles both sending and analytics.
 * Extends EmailProviderBase to work with Ghost's adapter system.
 */
class PostmarkAdapter extends EmailProviderBase {
    // Required methods that Ghost expects
    static requiredFns = ['send', 'getMaximumRecipients', 'getTargetDeliveryWindow', 'fetchLatest'];

    #postmarkClient;
    #errorHandler;
    #logging;
    #errors;
    #debug;

    /**
     * @param {Object} config - Adapter configuration
     * @param {string} config.serverToken - Postmark Server API token
     * @param {string} [config.messageStream] - Message stream (default: "broadcasts")
     * @param {boolean} [config.bulkApiEnabled] - Enable Bulk Email API (default: false)
     * @param {string} [config.apiUrl] - Postmark API URL (default: "https://api.postmarkapp.com")
     * @param {number} [config.batchSize] - Batch size override
     * @param {number} [config.targetDeliveryWindow] - Delivery window in seconds
     * @param {Object} config.configService - Ghost config service
     * @param {Object} config.settingsCache - Ghost settings cache
     * @param {Function} [config.errorHandler] - Custom error handler
     */
    constructor(config = {}) {
        super(config);

        // Extract Ghost services from config
        const {configService, settingsCache, errorHandler} = config;
        this.#errorHandler = errorHandler;

        // Try to load Ghost dependencies
        try {
            this.#logging = require('@tryghost/logging');
            this.#errors = require('@tryghost/errors');
            this.#debug = require('@tryghost/debug')('email-adapter:postmark');
        } catch (e) {
            // Fallback to console if Ghost packages not available
            this.#logging = console;
            this.#errors = {
                EmailError: class EmailError extends Error {
                    constructor({message, statusCode, errorDetails, context, code}) {
                        super(message);
                        this.statusCode = statusCode;
                        this.errorDetails = errorDetails;
                        this.context = context;
                        this.code = code;
                    }
                },
                IncorrectUsageError: class IncorrectUsageError extends Error {
                    constructor({message}) {
                        super(message);
                    }
                }
            };
            this.#debug = () => {};
        }

        // Expose requiredFns as instance property (Ghost checks this)
        this.requiredFns = PostmarkAdapter.requiredFns;

        // Only initialize Postmark client if we have the required Ghost dependencies
        if (configService && settingsCache) {
            // Initialize Postmark client
            this.#postmarkClient = new PostmarkClient({
                config: configService,
                settings: settingsCache
            });

            if (!this.#postmarkClient.isConfigured()) {
                this.#logging.warn('[Postmark Adapter] Postmark is not configured. Please add postmark configuration to config.[env].json');
            } else {
                this.#logging.info('[Postmark Adapter] Initialized successfully');
            }
        }
    }

    /**
     * Create recipient data object from replacements
     *
     * @param {Array<Object>} replacements
     * @returns {Object}
     * @private
     */
    #createRecipientData(replacements) {
        return replacements.reduce((acc, replacement) => {
            const {id, value} = replacement;
            acc[id] = value;
            return acc;
        }, {});
    }

    /**
     * Create Postmark error message for storing in the database
     *
     * @param {Object} error
     * @returns {string}
     * @private
     */
    #createPostmarkErrorMessage(error) {
        const message = (error?.message || 'Postmark Error') + (error?.details ? (': ' + error.details) : '');
        return message.slice(0, 2000);
    }

    /**
     * Send an email using the Postmark API
     *
     * @param {Object} data - Email data
     * @param {Object} options - Sending options
     * @returns {Promise<{id: string}>}
     */
    async send(data, options) {
        if (!this.#postmarkClient) {
            throw new this.#errors.IncorrectUsageError({
                message: 'Postmark adapter not initialized. Please provide configService and settingsCache.'
            });
        }

        const {
            subject,
            html,
            plaintext,
            from,
            replyTo,
            emailId,
            recipients,
            replacementDefinitions
        } = data;

        this.#logging.info(`[Postmark Adapter] Sending email to ${recipients.length} recipients`);
        const startTime = Date.now();
        this.#debug(`sending message to ${recipients.length} recipients`);

        try {
            const messageData = {
                subject,
                html,
                plaintext,
                from,
                replyTo,
                id: emailId,
                track_opens: !!options.openTrackingEnabled,
                track_clicks: !!options.clickTrackingEnabled
            };

            if (options.deliveryTime && options.deliveryTime instanceof Date) {
                messageData.deliveryTime = options.deliveryTime;
            }

            // Create recipient data for Postmark
            const recipientData = recipients.reduce((acc, recipient) => {
                acc[recipient.email] = this.#createRecipientData(recipient.replacements);
                return acc;
            }, {});

            // Create replacements array with regexp for client to use
            const replacements = replacementDefinitions.map((def) => {
                // Extract the actual token from the RegExp object or pattern string
                let token;
                if (def.token instanceof RegExp) {
                    // If it's a RegExp object, get the source pattern
                    token = def.token.source;
                } else if (typeof def.token === 'string') {
                    // If it's a string that looks like a regex pattern (e.g., "/pattern/g"), extract the pattern
                    const regexMatch = def.token.match(/^\/(.+)\/[gimuy]*$/);
                    if (regexMatch) {
                        token = regexMatch[1];
                    } else {
                        token = def.token;
                    }
                } else {
                    token = String(def.token || '');
                }

                // Unescape the token (Ghost escapes special chars in the pattern)
                // e.g., "%%\{uuid\}%%" should become "%%{uuid}%%"
                token = token.replace(/\\(.)/g, '$1');

                // The token is already a regex pattern from Ghost (it may contain regex syntax like (?:...|...))
                // So we use it directly as a regex pattern instead of escaping it
                let regexp;
                try {
                    regexp = new RegExp(token, 'g');
                } catch (e) {
                    // If the token is not a valid regex pattern, escape it and use as literal
                    this.#logging.warn(`[Postmark Adapter] Token is not valid regex pattern for ${def.id}, using as literal: ${e.message}`);
                    regexp = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                }

                return {
                    id: def.id,
                    token: token,
                    regexp: regexp
                };
            });

            // Send the email using Postmark client
            // The client handles Bulk API with fallback to traditional API
            const response = await this.#postmarkClient.send(
                messageData,
                recipientData,
                replacements
            );

            this.#debug(`sent message (${Date.now() - startTime}ms)`);
            this.#logging.info(`[Postmark Adapter] Sent message (${Date.now() - startTime}ms)`);

            return {
                id: response.id
            };
        } catch (e) {
            let ghostError;

            if (e.code === 'POSTMARK_API_ERROR' || e.code === 'POSTMARK_NETWORK_ERROR') {
                // Already a Ghost error from PostmarkClient
                ghostError = e;
            } else if (e.error && e.messageData) {
                const {error, messageData} = e;

                ghostError = new this.#errors.EmailError({
                    statusCode: error.status,
                    message: this.#createPostmarkErrorMessage(error),
                    errorDetails: JSON.stringify({error, messageData}),
                    context: `Postmark Error ${error.status}: ${error.details}`,
                    help: 'https://postmarkapp.com/support',
                    code: 'BULK_EMAIL_SEND_FAILED'
                });
            } else {
                ghostError = new this.#errors.EmailError({
                    statusCode: undefined,
                    message: this.#createPostmarkErrorMessage(e),
                    errorDetails: undefined,
                    context: e.context || 'Postmark Error',
                    code: 'BULK_EMAIL_SEND_FAILED'
                });
            }

            this.#debug(`failed to send message (${Date.now() - startTime}ms)`);

            // Call error handler if provided
            if (this.#errorHandler) {
                this.#errorHandler(ghostError);
            }

            throw ghostError;
        }
    }

    /**
     * Get maximum recipients per batch
     *
     * @returns {number}
     */
    getMaximumRecipients() {
        if (!this.#postmarkClient) {
            throw new this.#errors.IncorrectUsageError({
                message: 'Postmark adapter not initialized. Please provide configService and settingsCache.'
            });
        }
        return this.#postmarkClient.getBatchSize();
    }

    /**
     * Get target delivery window in milliseconds
     *
     * @returns {number}
     */
    getTargetDeliveryWindow() {
        if (!this.#postmarkClient) {
            throw new this.#errors.IncorrectUsageError({
                message: 'Postmark adapter not initialized. Please provide configService and settingsCache.'
            });
        }
        return this.#postmarkClient.getTargetDeliveryWindow();
    }

    /**
     * Fetch latest email events for analytics
     *
     * @param {Function} batchHandler - Handler for processing event batches
     * @param {Object} [options] - Fetch options
     * @param {number} [options.maxEvents] - Maximum events to fetch (not strict)
     * @param {Date} [options.begin] - Start date for events
     * @param {Date} [options.end] - End date for events
     * @param {String[]} [options.events] - Event types to fetch
     * @returns {Promise<void>}
     */
    async fetchLatest(batchHandler, options) {
        if (!this.#postmarkClient) {
            throw new this.#errors.IncorrectUsageError({
                message: 'Postmark adapter not initialized. Please provide configService and settingsCache.'
            });
        }
        const postmarkOptions = {
            count: 500
        };

        // Add date filters if provided
        if (options?.begin) {
            // Postmark uses Eastern Time, format as YYYY-MM-DD
            postmarkOptions.fromdate = this.#formatDate(options.begin);
        }

        if (options?.end) {
            postmarkOptions.todate = this.#formatDate(options.end);
        }

        // Add message stream filter (for newsletters/bulk emails)
        // By default, look in the broadcasts stream where bulk emails are sent
        const {configService} = this.config;
        const bulkEmailConfig = configService.get('bulkEmail');
        const messageStream = bulkEmailConfig?.postmark?.messageStream || 'broadcasts';
        postmarkOptions.messagestream = messageStream;

        return await this.#postmarkClient.fetchEvents(postmarkOptions, batchHandler, {
            maxEvents: options?.maxEvents
        });
    }

    /**
     * Format date for Postmark API (YYYY-MM-DD)
     *
     * @param {Date} date
     * @returns {string}
     * @private
     */
    #formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

module.exports = PostmarkAdapter;
