
# Pet


## Properties

Name | Type
------------ | -------------
`name` | string
`species` | string
`id` | number

## Example

```typescript
import type { Pet } from ''

// TODO: Update the object below with actual values
const example = {
  "name": null,
  "species": null,
  "id": null,
} satisfies Pet

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as Pet
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


