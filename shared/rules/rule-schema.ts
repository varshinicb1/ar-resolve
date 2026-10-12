// Copied verbatim from the build pack specs/rule.schema.json (urn:ar-resolve:rule:1).
// Rule studio validates the schema projection of every draft against it (ADR 0020).
export const RULE_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:ar-resolve:rule:1",
  "title": "Draft rule pack",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "version",
    "status",
    "scope",
    "effectiveFrom",
    "effectiveThrough",
    "owner",
    "approvalRequired",
    "supportedAssumptions",
    "requiredFacts",
    "actions",
    "prohibitedActions",
    "sources",
    "branches"
  ],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[A-Z0-9_]+$"
    },
    "version": {
      "type": "integer",
      "minimum": 1
    },
    "status": {
      "enum": [
        "draft",
        "approved",
        "retired"
      ]
    },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "tenant",
        "client",
        "payer",
        "plan",
        "claimType"
      ],
      "properties": {
        "tenant": {
          "type": "string",
          "minLength": 1
        },
        "client": {
          "type": "string",
          "minLength": 1
        },
        "payer": {
          "type": "string",
          "minLength": 1
        },
        "plan": {
          "type": "string",
          "minLength": 1
        },
        "claimType": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "effectiveFrom": {
      "type": "string",
      "format": "date"
    },
    "effectiveThrough": {
      "type": "string",
      "format": "date"
    },
    "owner": {
      "type": "string",
      "minLength": 1
    },
    "approvalRequired": {
      "const": true
    },
    "branches": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "when",
          "propose"
        ],
        "properties": {
          "when": {
            "type": "string",
            "minLength": 1
          },
          "propose": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    },
    "supportedAssumptions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    },
    "requiredFacts": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    },
    "actions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    },
    "prohibitedActions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    },
    "sources": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    }
  }
};
