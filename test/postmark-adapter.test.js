const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const assert = require('node:assert/strict');

describe('Postmark Adapter', function () {
    let PostmarkAdapter;
    let PostmarkClientStub;
    let configService;
    let settingsCache;

    beforeEach(function () {
        // Create PostmarkClient stub class
        PostmarkClientStub = sinon.stub();
        PostmarkClientStub.prototype.isConfigured = sinon.stub().returns(true);
        PostmarkClientStub.prototype.send = sinon.stub().resolves({id: 'msg-123'});
        PostmarkClientStub.prototype.getBatchSize = sinon.stub().returns(500);
        PostmarkClientStub.prototype.getTargetDeliveryWindow = sinon.stub().returns(3600000);
        PostmarkClientStub.prototype.fetchEvents = sinon.stub().resolves();

        // Load PostmarkAdapter with mocked PostmarkClient
        PostmarkAdapter = proxyquire('../lib/postmark-adapter', {
            './postmark-client': PostmarkClientStub
        });

        // Mock Ghost services
        configService = {
            get: sinon.stub().returns({
                postmark: {
                    serverToken: 'test-token',
                    messageStream: 'broadcasts',
                    bulkApiEnabled: true
                }
            })
        };

        settingsCache = {
            get: sinon.stub()
        };
    });

    afterEach(function () {
        sinon.restore();
    });

    it('has required functions defined', function () {
        assert.deepEqual(
            PostmarkAdapter.requiredFns,
            ['send', 'getMaximumRecipients', 'getTargetDeliveryWindow', 'fetchLatest']
        );
    });

    it('stores config in constructor', function () {
        const config = {
            configService,
            settingsCache
        };

        const adapter = new PostmarkAdapter(config);

        assert.equal(adapter.config, config);
    });

    it('exposes requiredFns as instance property', function () {
        const adapter = new PostmarkAdapter({
            configService,
            settingsCache
        });

        assert.deepEqual(adapter.requiredFns, PostmarkAdapter.requiredFns);
    });

    describe('send', function () {
        it('calls PostmarkClient.send with correct data', async function () {
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            const data = {
                subject: 'Test Email',
                html: '<html><body>Hello {{name}}</body></html>',
                plaintext: 'Hello {{name}}',
                from: 'sender@example.com',
                replyTo: 'reply@example.com',
                emailId: 'email-123',
                recipients: [
                    {email: 'test1@example.com', replacements: [{id: 'name', value: 'John'}]},
                    {email: 'test2@example.com', replacements: [{id: 'name', value: 'Jane'}]}
                ],
                replacementDefinitions: [
                    {id: 'name', token: '{{name}}'}
                ]
            };

            const options = {
                openTrackingEnabled: true,
                clickTrackingEnabled: true
            };

            const result = await adapter.send(data, options);

            assert.ok(PostmarkClientStub.prototype.send.calledOnce);

            const [messageData, recipientData, replacements] = PostmarkClientStub.prototype.send.firstCall.args;

            // Verify message data
            assert.equal(messageData.subject, 'Test Email');
            assert.equal(messageData.html, '<html><body>Hello {{name}}</body></html>');
            assert.equal(messageData.from, 'sender@example.com');
            assert.equal(messageData.track_opens, true);
            assert.equal(messageData.track_clicks, true);

            // Verify recipient data
            assert.deepEqual(recipientData, {
                'test1@example.com': {name: 'John'},
                'test2@example.com': {name: 'Jane'}
            });

            // Verify replacements
            assert.equal(replacements.length, 1);
            assert.equal(replacements[0].id, 'name');
            assert.equal(replacements[0].token, '{{name}}');
            assert.ok(replacements[0].regexp);

            // Verify result
            assert.deepEqual(result, {id: 'msg-123'});
        });

        it('includes deliveryTime in message data when provided', async function () {
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            const deliveryTime = new Date('2024-01-01T12:00:00Z');

            const data = {
                subject: 'Test',
                html: '<html><body>Test</body></html>',
                from: 'sender@example.com',
                recipients: [{email: 'test@example.com', replacements: []}],
                replacementDefinitions: []
            };

            const options = {
                deliveryTime
            };

            await adapter.send(data, options);

            const [messageData] = PostmarkClientStub.prototype.send.firstCall.args;
            assert.equal(messageData.deliveryTime, deliveryTime);
        });

        it('calls error handler on failure', async function () {
            const errorHandler = sinon.stub();
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache,
                errorHandler
            });

            const sendError = new Error('Send failed');
            sendError.code = 'POSTMARK_API_ERROR';
            PostmarkClientStub.prototype.send.rejects(sendError);

            const data = {
                subject: 'Test',
                html: '<html><body>Test</body></html>',
                from: 'sender@example.com',
                recipients: [{email: 'test@example.com', replacements: []}],
                replacementDefinitions: []
            };

            await assert.rejects(
                async () => await adapter.send(data, {}),
                {code: 'POSTMARK_API_ERROR'}
            );

            assert.ok(errorHandler.calledOnce);
        });
    });

    describe('getMaximumRecipients', function () {
        it('returns value from PostmarkClient', function () {
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            const result = adapter.getMaximumRecipients();

            assert.ok(PostmarkClientStub.prototype.getBatchSize.calledOnce);
            assert.equal(result, 500);
        });
    });

    describe('getTargetDeliveryWindow', function () {
        it('returns value from PostmarkClient', function () {
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            const result = adapter.getTargetDeliveryWindow();

            assert.ok(PostmarkClientStub.prototype.getTargetDeliveryWindow.calledOnce);
            assert.equal(result, 3600000);
        });
    });

    describe('fetchLatest', function () {
        it('calls PostmarkClient.fetchEvents with correct options', async function () {
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            const batchHandler = sinon.stub();
            const options = {
                maxEvents: 100,
                begin: new Date('2024-01-01'),
                end: new Date('2024-01-31')
            };

            await adapter.fetchLatest(batchHandler, options);

            assert.ok(PostmarkClientStub.prototype.fetchEvents.calledOnce);

            const [postmarkOptions, handler, fetchOptions] = PostmarkClientStub.prototype.fetchEvents.firstCall.args;

            // Verify postmark options
            assert.equal(postmarkOptions.count, 500);
            assert.equal(postmarkOptions.fromdate, '2024-01-01');
            assert.equal(postmarkOptions.todate, '2024-01-31');
            assert.equal(postmarkOptions.messagestream, 'broadcasts');

            // Verify handler
            assert.equal(handler, batchHandler);

            // Verify fetch options
            assert.equal(fetchOptions.maxEvents, 100);
        });

        it('uses default message stream when not configured', async function () {
            configService.get.returns({
                postmark: {
                    serverToken: 'test-token'
                }
            });

            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            await adapter.fetchLatest(sinon.stub(), {});

            const [postmarkOptions] = PostmarkClientStub.prototype.fetchEvents.firstCall.args;
            assert.equal(postmarkOptions.messagestream, 'broadcasts');
        });

        it('formats dates correctly', async function () {
            const adapter = new PostmarkAdapter({
                configService,
                settingsCache
            });

            const options = {
                begin: new Date('2024-03-05T10:30:00Z'),
                end: new Date('2024-03-15T15:45:00Z')
            };

            await adapter.fetchLatest(sinon.stub(), options);

            const [postmarkOptions] = PostmarkClientStub.prototype.fetchEvents.firstCall.args;
            assert.equal(postmarkOptions.fromdate, '2024-03-05');
            assert.equal(postmarkOptions.todate, '2024-03-15');
        });
    });
});
