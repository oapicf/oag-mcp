
# Pet


## Properties

Name | Type
------------ | -------------
`id` | number
`name` | string
`species` | [Species](Species.md)
`birthDate` | Date
`ownerId` | number
`vaccinated` | boolean
`weightKg` | number

## Example

```typescript
import type { Pet } from 'petclinic-sdk'

// TODO: Update the object below with actual values
const example = {
  "id": 1,
  "name": Biscuit,
  "species": null,
  "birthDate": null,
  "ownerId": null,
  "vaccinated": null,
  "weightKg": null,
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


