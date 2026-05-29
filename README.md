# ghost-email-postmark

Postmark email provider adapter for Ghost with batch email support.

## Features

- **Batch Email Sending**: Send up to 500 emails per batch using Postmark's batch API
- **Email Analytics**: Fetch email events for delivery, opens, clicks, bounces, and spam complaints
- **Ghost Integration**: Seamlessly integrates with Ghost's email adapter pattern
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
      "messageStream": "outbound",
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

- `messageStream`: Message stream to use (default: "outbound")
- `apiUrl`: Postmark API URL (default: "https://api.postmarkapp.com")
- `batchSize`: Maximum recipients per batch (default: 500)
- `targetDeliveryWindow`: Delivery window in seconds for rate limiting (default: 0)

## Email Sending

### Batch API

The adapter uses Postmark's batch email API:

1. Applies replacements individually per recipient
2. Uses batch endpoint (`/email/batch`) for multiple recipients
3. Uses single email endpoint (`/email`) for one recipient
4. Returns message ID

**Features:**
- Up to 500 recipients per batch
- Individual personalization per recipient
- Open and click tracking
- Metadata for analytics

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
