
# NewPet


## Properties

Name | Type
------------ | -------------
`name` | string
`species` | [Species](Species.md)
`ownerId` | number

## Example

```typescript
import type { NewPet } from 'petclinic-sdk'

// TODO: Update the object below with actual values
const example = {
  "name": Biscuit,
  "species": null,
  "ownerId": null,
} satisfies NewPet

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as NewPet
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


