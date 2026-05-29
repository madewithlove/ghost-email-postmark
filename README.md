# ghost-email-postmark

Postmark email provider adapter for Ghost with Bulk Email API support.

## Features

- **Bulk Email API Support**: Automatically uses Postmark's Bulk Email API when available
- **Automatic Fallback**: Falls back to traditional Postmark API if Bulk API fails
- **Email Analytics**: Fetch email events for delivery, opens, clicks, bounces, and spam complaints
- **Ghost Integration**: Seamlessly integrates with Ghost's email adapter pattern
- **Batch Sending**: Send up to 500 emails per batch
- **Personalization**: Full support for Ghost's replacement variables (merge tags)
- **Zero Ghost Footprint**: No Postmark code in Ghost core - loaded dynamically from npm

## Installation

### Option 1: Install from npm (when published)

```bash
cd ghost/core
npm install ghost-email-postmark
```

### Option 2: Install locally (for development)

```bash
cd ghost/core
npm install /path/to/ghost-email-postmark
```

### Option 3: Link for development

```bash
cd /path/to/ghost-email-postmark
npm link

cd /path/to/ghost/ghost/core
npm link ghost-email-postmark
```

## Configuration

Ghost will automatically load the adapter from node_modules when configured.

### 1. Update Ghost config

Add to your `config.[env].json`:

```json
{
  "bulkEmail": {
    "provider": "ghost-email-postmark",
    "postmark": {
      "serverToken": "your-postmark-server-token",
      "messageStream": "broadcasts",
      "bulkApiEnabled": true,
      "apiUrl": "https://api.postmarkapp.com"
    },
    "batchSize": 500,
    "targetDeliveryWindow": 3600
  }
}
```

### 2. Restart Ghost

Ghost will automatically:
1. Detect `ghost-email-postmark` as the provider
2. Load the adapter from `node_modules/ghost-email-postmark`
3. Validate it implements the required methods
4. Use it for email sending and analytics

**That's it!** No code changes needed in Ghost.

## How It Works

### Dynamic Loading

Ghost's adapter manager automatically:
1. Checks `node_modules` for the adapter package
2. Loads the adapter class
3. Validates it has `requiredFns` property
4. Validates all required methods are implemented
5. Instantiates the adapter with Ghost config

### Adapter Interface

The adapter implements Ghost's email provider interface:

```javascript
class PostmarkAdapter {
    static requiredFns = ['send', 'getMaximumRecipients', 'getTargetDeliveryWindow', 'fetchLatest'];

    async send(data, options) { }
    getMaximumRecipients() { }
    getTargetDeliveryWindow() { }
    async fetchLatest(batchHandler, options) { }
}
```

## Configuration Options

### Required

- `serverToken`: Your Postmark Server API token

### Optional

- `messageStream`: Message stream to use (default: "broadcasts" for Bulk API, "outbound" for traditional)
- `bulkApiEnabled`: Enable Bulk Email API (default: false)
- `apiUrl`: Postmark API URL (default: "https://api.postmarkapp.com")
- `batchSize`: Maximum recipients per batch (default: 500)
- `targetDeliveryWindow`: Delivery window in seconds for rate limiting (default: 0)

## Email Sending

### Bulk API (Recommended)

When `bulkApiEnabled: true` and no scheduled delivery:

1. Converts replacement tokens to Postmark template syntax (`{{variable}}`)
2. Sends single API request with all recipients
3. Returns bulk request ID

**Advantages:**
- Single API call per batch
- More efficient for large batches
- Better rate limits

### Traditional API (Fallback)

Automatically used when:
- Bulk API disabled
- Bulk API fails
- Scheduled delivery requested

1. Applies replacements individually per recipient
2. Uses batch endpoint for multiple recipients
3. Returns message ID

## Email Analytics

### Event Fetching

1. Fetches messages from Postmark Messages API (500 per page)
2. Gets detailed events for each message
3. Normalizes events to Ghost format
4. Processes events in batches

### Event Type Mapping

| Postmark Event | Ghost Event | Description |
|----------------|-------------|-------------|
| Delivered | delivered | Successfully delivered |
| Bounced | failed | Delivery failed (bounce) |
| Opened | opened | Email opened |
| LinkClicked | clicked | Link clicked |
| SpamComplaint | complained | Marked as spam |
| SubscriptionChange | unsubscribed | Unsubscribed |

## Development

### Testing Locally

1. **Link the package:**
   ```bash
   cd /path/to/ghost-email-postmark
   npm link
   ```

2. **Link in Ghost:**
   ```bash
   cd /path/to/ghost/ghost/core
   npm link ghost-email-postmark
   ```

3. **Configure Ghost:**
   ```json
   {
     "bulkEmail": {
       "provider": "ghost-email-postmark",
       "postmark": {
         "serverToken": "your-test-token"
       }
     }
   }
   ```

4. **Start Ghost and test**

### Publishing

```bash
cd /path/to/ghost-email-postmark
npm publish
```

## License

MIT

## Support

For issues specific to this adapter:
- GitHub Issues: https://github.com/madewithlove/ghost-email-postmark/issues

For Postmark API issues:
- Postmark Support: https://postmarkapp.com/support

For Ghost integration issues:
- Ghost Documentation: https://ghost.org/docs/
