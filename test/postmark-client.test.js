const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const assert = require('node:assert/strict');

describe('PostmarkClient', function () {
    let PostmarkClient;
    let config;
    let settings;
    let fetchStub;
    let mockLogging;
    let mockErrors;
    let mockDebug;
    let mockMetrics;

    beforeEach(function () {
        // Mock @tryghost dependencies
        mockLogging = {
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub()
        };

        mockErrors = {
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

        mockDebug = sinon.stub().returns(sinon.stub());
        mockMetrics = {
            metric: sinon.stub()
        };

        // Load PostmarkClient with mocked dependencies
        PostmarkClient = proxyquire('../lib/postmark-client', {
            '@tryghost/logging': mockLogging,
            '@tryghost/errors': mockErrors,
            '@tryghost/debug': mockDebug,
            '@tryghost/metrics': mockMetrics
        });

        // Mock config service
        config = {
            get: sinon.stub()
        };

        config.get.withArgs('bulkEmail').returns({
            postmark: {
                serverToken: 'test-server-token',
                messageStream: 'broadcasts',
                bulkApiEnabled: true,
                apiUrl: 'https://api.postmarkapp.com'
            },
            targetDeliveryWindow: 3600
        });

        settings = {
            get: sinon.stub()
        };

        // Mock global fetch
        fetchStub = sinon.stub(global, 'fetch');
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () {
        it('creates instance with config and settings', function () {
            const client = new PostmarkClient({config, settings});
            assert.ok(client);
        });
    });

    describe('isConfigured', function () {
        it('returns true when serverToken is configured', function () {
            const client = new PostmarkClient({config, settings});
            assert.equal(client.isConfigured(), true);
        });

        it('returns false when serverToken is missing', function () {
            config.get.withArgs('bulkEmail').returns({
                postmark: {}
            });

            const client = new PostmarkClient({config, settings});
            assert.equal(client.isConfigured(), false);
        });

        it('returns false when postmark config is missing', function () {
            config.get.withArgs('bulkEmail').returns({});

            const client = new PostmarkClient({config, settings});
            assert.equal(client.isConfigured(), false);
        });
    });

    describe('getBatchSize', function () {
        it('returns BULK_API_BATCH_SIZE when bulk API is enabled', function () {
            const client = new PostmarkClient({config, settings});
            assert.equal(client.getBatchSize(), 500);
        });

        it('returns DEFAULT_BATCH_SIZE when bulk API is disabled', function () {
            config.get.withArgs('bulkEmail').returns({
                postmark: {
                    serverToken: 'test-token',
                    bulkApiEnabled: false
                }
            });

            const client = new PostmarkClient({config, settings});
            assert.equal(client.getBatchSize(), 500);
        });
    });

    describe('getTargetDeliveryWindow', function () {
        it('returns configured target delivery window', function () {
            const client = new PostmarkClient({config, settings});
            assert.equal(client.getTargetDeliveryWindow(), 3600);
        });

        it('returns 0 when not configured', function () {
            config.get.withArgs('bulkEmail').returns({
                postmark: {serverToken: 'test-token'}
            });

            const client = new PostmarkClient({config, settings});
            assert.equal(client.getTargetDeliveryWindow(), 0);
        });

        it('returns 0 for negative values', function () {
            config.get.withArgs('bulkEmail').returns({
                postmark: {serverToken: 'test-token'},
                targetDeliveryWindow: -100
            });

            const client = new PostmarkClient({config, settings});
            assert.equal(client.getTargetDeliveryWindow(), 0);
        });
    });

    describe('send', function () {
        let message;
        let recipientData;
        let replacements;

        beforeEach(function () {
            message = {
                subject: 'Test Subject',
                html: '<html><body>Hello {{name}}</body></html>',
                plaintext: 'Hello {{name}}',
                from: 'sender@example.com',
                replyTo: 'reply@example.com',
                id: 'email-123',
                track_opens: true,
                track_clicks: true
            };

            recipientData = {
                'test1@example.com': {name: 'John'},
                'test2@example.com': {name: 'Jane'}
            };

            replacements = [
                {
                    id: 'name',
                    token: '{{name}}',
                    regexp: /\{\{name\}\}/g
                }
            ];
        });

        describe('Bulk API', function () {
            it('sends via Bulk API when enabled', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves({
                        ID: 'bulk-123',
                        SubmittedAt: '2024-01-01T12:00:00Z'
                    })
                });

                const client = new PostmarkClient({config, settings});
                const result = await client.send(message, recipientData, replacements);

                assert.ok(fetchStub.calledOnce);
                assert.equal(result.id, 'bulk-123');

                const [url, options] = fetchStub.firstCall.args;
                assert.equal(url, 'https://api.postmarkapp.com/email/bulk');
                assert.equal(options.method, 'POST');
                assert.equal(options.headers['X-Postmark-Server-Token'], 'test-server-token');

                const payload = JSON.parse(options.body);
                assert.equal(payload.From, 'sender@example.com');
                assert.equal(payload.Subject, 'Test Subject');
                assert.equal(payload.MessageStream, 'broadcasts');
                assert.equal(payload.TrackOpens, true);
                assert.equal(payload.TrackLinks, 'HtmlAndText');
                assert.equal(payload.Messages.length, 2);
                assert.deepEqual(payload.Messages[0], {
                    To: 'test1@example.com',
                    TemplateModel: {name: 'John'}
                });
            });

            it('converts replacements to Postmark template syntax', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves({ID: 'bulk-123'})
                });

                const client = new PostmarkClient({config, settings});
                await client.send(message, recipientData, replacements);

                const payload = JSON.parse(fetchStub.firstCall.args[1].body);
                assert.equal(payload.HtmlBody, '<html><body>Hello {{name}}</body></html>');
                assert.equal(payload.TextBody, 'Hello {{name}}');
            });

            it('includes metadata in bulk request', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves({ID: 'bulk-123'})
                });

                const client = new PostmarkClient({config, settings});
                await client.send(message, recipientData, replacements);

                const payload = JSON.parse(fetchStub.firstCall.args[1].body);
                assert.deepEqual(payload.Metadata, {'email-id': 'email-123'});
            });

            it('falls back to traditional API on Bulk API failure', async function () {
                // First call (Bulk API) fails
                fetchStub.onFirstCall().resolves({
                    ok: false,
                    status: 422,
                    json: sinon.stub().resolves({
                        Message: 'Bulk API Error'
                    })
                });

                // Second call (traditional API) succeeds
                fetchStub.onSecondCall().resolves({
                    ok: true,
                    json: sinon.stub().resolves([
                        {MessageID: 'msg-1'},
                        {MessageID: 'msg-2'}
                    ])
                });

                const client = new PostmarkClient({config, settings});
                const result = await client.send(message, recipientData, replacements);

                assert.equal(fetchStub.callCount, 2);
                assert.equal(result.id, 'msg-1');
            });

            it('uses traditional API when deliveryTime is set', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves([{MessageID: 'msg-1'}])
                });

                message.deliveryTime = new Date('2024-01-01T12:00:00Z');

                const client = new PostmarkClient({config, settings});
                await client.send(message, recipientData, replacements);

                // Should use batch endpoint
                const url = fetchStub.firstCall.args[0];
                assert.equal(url, 'https://api.postmarkapp.com/email/batch');
            });

            it('handles API errors correctly', async function () {
                // Mock API error response
                fetchStub.resolves({
                    ok: false,
                    status: 422,
                    json: sinon.stub().resolves({
                        Message: 'Request is too large',
                        ErrorCode: 413
                    })
                });

                const client = new PostmarkClient({config, settings});

                await assert.rejects(
                    async () => await client.send(message, recipientData, replacements),
                    {code: 'POSTMARK_API_ERROR'}
                );
            });
        });

        describe('Traditional API', function () {
            beforeEach(function () {
                config.get.withArgs('bulkEmail').returns({
                    postmark: {
                        serverToken: 'test-token',
                        bulkApiEnabled: false
                    }
                });
            });

            it('sends via batch endpoint for multiple recipients', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves([
                        {MessageID: 'msg-1'},
                        {MessageID: 'msg-2'}
                    ])
                });

                const client = new PostmarkClient({config, settings});
                const result = await client.send(message, recipientData, replacements);

                assert.ok(fetchStub.calledOnce);
                assert.equal(result.id, 'msg-1');

                const [url, options] = fetchStub.firstCall.args;
                assert.equal(url, 'https://api.postmarkapp.com/email/batch');
                assert.equal(options.method, 'POST');

                const payload = JSON.parse(options.body);
                assert.equal(payload.length, 2);
                assert.equal(payload[0].To, 'test1@example.com');
                assert.equal(payload[0].MessageStream, 'outbound');
            });

            it('applies replacements per recipient', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves([{MessageID: 'msg-1'}])
                });

                const client = new PostmarkClient({config, settings});
                await client.send(message, recipientData, replacements);

                const payload = JSON.parse(fetchStub.firstCall.args[1].body);
                assert.equal(payload[0].HtmlBody, '<html><body>Hello John</body></html>');
                assert.equal(payload[1].HtmlBody, '<html><body>Hello Jane</body></html>');
            });

            it('uses single email endpoint for one recipient', async function () {
                fetchStub.resolves({
                    ok: true,
                    json: sinon.stub().resolves({MessageID: 'msg-1'})
                });

                const singleRecipientData = {
                    'test@example.com': {name: 'John'}
                };

                const client = new PostmarkClient({config, settings});
                await client.send(message, singleRecipientData, replacements);

                const url = fetchStub.firstCall.args[0];
                assert.equal(url, 'https://api.postmarkapp.com/email');
            });
        });

        it('returns null when not configured', async function () {
            config.get.withArgs('bulkEmail').returns({});

            const client = new PostmarkClient({config, settings});
            const result = await client.send(message, recipientData, replacements);

            assert.equal(result, null);
        });

        it('throws error for too many recipients', async function () {
            const tooManyRecipients = {};
            for (let i = 0; i < 501; i++) {
                tooManyRecipients[`test${i}@example.com`] = {name: 'Test'};
            }

            const client = new PostmarkClient({config, settings});

            await assert.rejects(
                async () => await client.send(message, tooManyRecipients, replacements),
                /only supports sending to 500 recipients/
            );
        });
    });

    describe('fetchEvents', function () {
        it('fetches and processes message events', async function () {
            const startDate = new Date();

            // Mock messages response - need to return a Promise with json method
            const messagesResponse = {
                ok: true,
                json: sinon.stub().resolves({
                    Messages: [
                        {
                            MessageID: 'msg-1',
                            Recipients: ['test@example.com'],
                            Metadata: {'email-id': 'email-123'}
                        }
                    ]
                })
            };

            // Mock message details response - use a date in the past
            const detailsResponse = {
                ok: true,
                json: sinon.stub().resolves({
                    MessageEvents: [
                        {
                            Type: 'Delivered',
                            ReceivedAt: new Date(startDate.getTime() - 1000).toISOString(),
                            Recipient: 'test@example.com'
                        }
                    ]
                })
            };

            // Mock empty messages response for second page (to stop pagination)
            const emptyMessagesResponse = {
                ok: true,
                json: sinon.stub().resolves({
                    Messages: []
                })
            };

            // Setup stubs
            fetchStub.onCall(0).resolves(messagesResponse);
            fetchStub.onCall(1).resolves(detailsResponse);
            fetchStub.onCall(2).resolves(emptyMessagesResponse);

            const client = new PostmarkClient({config, settings});
            const batchHandler = sinon.stub();

            await client.fetchEvents(
                {count: 500, messagestream: 'broadcasts'},
                batchHandler,
                {maxEvents: 100}
            );

            assert.ok(fetchStub.callCount >= 2);
            assert.ok(batchHandler.calledOnce);

            const events = batchHandler.firstCall.args[0];
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'delivered');
            assert.equal(events[0].recipientEmail, 'test@example.com');
        });

        it('stops when no more messages', async function () {
            // First call returns empty messages
            fetchStub.resolves({
                ok: true,
                json: sinon.stub().resolves({
                    Messages: []
                })
            });

            const client = new PostmarkClient({config, settings});
            const batchHandler = sinon.stub();

            await client.fetchEvents({count: 500}, batchHandler, {});

            assert.ok(fetchStub.calledOnce);
            assert.ok(batchHandler.notCalled);
        });
    });

    describe('normalizeEvent', function () {
        let client;

        beforeEach(function () {
            client = new PostmarkClient({config, settings});
        });

        it('normalizes Delivered event', function () {
            const event = {
                Type: 'Delivered',
                ReceivedAt: '2024-01-01T12:00:00Z',
                Recipient: 'test@example.com'
            };

            const message = {
                MessageID: 'msg-123',
                Metadata: {'email-id': 'email-123'}
            };

            const normalized = client.normalizeEvent(event, message);

            assert.equal(normalized.type, 'delivered');
            assert.equal(normalized.recipientEmail, 'test@example.com');
            assert.equal(normalized.emailId, 'email-123');
            assert.equal(normalized.providerId, 'msg-123');
            assert.deepEqual(normalized.timestamp, new Date('2024-01-01T12:00:00Z'));
        });

        it('normalizes Bounced event with error details', function () {
            const event = {
                Type: 'Bounced',
                ReceivedAt: '2024-01-01T12:00:00Z',
                Recipient: 'test@example.com',
                Details: {
                    BounceID: 'bounce-123',
                    Summary: 'Hard bounce',
                    Type: 'HardBounce'
                }
            };

            const message = {MessageID: 'msg-123'};

            const normalized = client.normalizeEvent(event, message);

            assert.equal(normalized.type, 'failed');
            assert.equal(normalized.severity, 'permanent');
            assert.equal(normalized.error.code, 'bounce-123');
            assert.equal(normalized.error.message, 'Hard bounce');
            assert.equal(normalized.error.enhancedCode, 'HardBounce');
        });

        it('normalizes Opened event', function () {
            const event = {
                Type: 'Opened',
                ReceivedAt: '2024-01-01T12:00:00Z',
                Recipient: 'test@example.com'
            };

            const normalized = client.normalizeEvent(event, {MessageID: 'msg-123'});
            assert.equal(normalized.type, 'opened');
        });

        it('normalizes LinkClicked event', function () {
            const event = {
                Type: 'LinkClicked',
                ReceivedAt: '2024-01-01T12:00:00Z',
                Recipient: 'test@example.com'
            };

            const normalized = client.normalizeEvent(event, {MessageID: 'msg-123'});
            assert.equal(normalized.type, 'clicked');
        });

        it('normalizes SpamComplaint event', function () {
            const event = {
                Type: 'SpamComplaint',
                ReceivedAt: '2024-01-01T12:00:00Z',
                Recipient: 'test@example.com'
            };

            const normalized = client.normalizeEvent(event, {MessageID: 'msg-123'});
            assert.equal(normalized.type, 'complained');
        });

        it('normalizes SubscriptionChange event', function () {
            const event = {
                Type: 'SubscriptionChange',
                ReceivedAt: '2024-01-01T12:00:00Z',
                Recipient: 'test@example.com'
            };

            const normalized = client.normalizeEvent(event, {MessageID: 'msg-123'});
            assert.equal(normalized.type, 'unsubscribed');
        });

        it('returns null for unknown event type', function () {
            const event = {
                Type: 'UnknownType',
                ReceivedAt: '2024-01-01T12:00:00Z'
            };

            const normalized = client.normalizeEvent(event, {MessageID: 'msg-123'});
            assert.equal(normalized, null);
        });

        it('returns null for invalid event', function () {
            const normalized = client.normalizeEvent(null, {MessageID: 'msg-123'});
            assert.equal(normalized, null);
        });
    });
});
