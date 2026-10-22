# PetsApi

All URIs are relative to *http://127.0.0.1:4010/v1*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**createPet**](PetsApi.md#createpet) | **POST** /pets | Register a new pet |
| [**getPetById**](PetsApi.md#getpetbyid) | **GET** /pets/{petId} | Get a pet by its identifier |
| [**listLegacyPets**](PetsApi.md#listlegacypets) | **GET** /legacy/pets | Legacy pet listing (redirects to /pets) |
| [**listPetVisits**](PetsApi.md#listpetvisits) | **GET** /pets/{petId}/visits | List the vet visits of a pet |
| [**listPets**](PetsApi.md#listpets) | **GET** /pets | List pets |



## createPet

> Pet createPet(newPet)

Register a new pet

Registers a new pet. Requires an OAuth2 client credentials token with the pets:write scope.

### Example

```ts
import {
  Configuration,
  PetsApi,
} from 'petclinic-sdk-variant';
import type { CreatePetRequest } from 'petclinic-sdk-variant';

async function example() {
  console.log("🚀 Testing petclinic-sdk-variant SDK...");
  const config = new Configuration({ 
    // To configure OAuth2 access token for authorization: clinicOAuth application
    accessToken: "YOUR ACCESS TOKEN",
  });
  const api = new PetsApi(config);

  const body = {
    // NewPet
    newPet: ...,
  } satisfies CreatePetRequest;

  try {
    const data = await api.createPet(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **newPet** | [NewPet](NewPet.md) |  | |

### Return type

[**Pet**](Pet.md)

### Authorization

[clinicOAuth application](../README.md#clinicOAuth-application)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | The created pet |  -  |
| **400** | Invalid pet |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getPetById

> Pet getPetById(petId)

Get a pet by its identifier

Public endpoint returning a single pet, including its owner and vaccination records.

### Example

```ts
import {
  Configuration,
  PetsApi,
} from 'petclinic-sdk-variant';
import type { GetPetByIdRequest } from 'petclinic-sdk-variant';

async function example() {
  console.log("🚀 Testing petclinic-sdk-variant SDK...");
  const api = new PetsApi();

  const body = {
    // number | Identifier of the pet
    petId: 1,
  } satisfies GetPetByIdRequest;

  try {
    const data = await api.getPetById(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **petId** | `number` | Identifier of the pet | [Defaults to `undefined`] |

### Return type

[**Pet**](Pet.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | The pet |  -  |
| **404** | Pet not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listLegacyPets

> Array&lt;Pet&gt; listLegacyPets()

Legacy pet listing (redirects to /pets)

### Example

```ts
import {
  Configuration,
  PetsApi,
} from 'petclinic-sdk-variant';
import type { ListLegacyPetsRequest } from 'petclinic-sdk-variant';

async function example() {
  console.log("🚀 Testing petclinic-sdk-variant SDK...");
  const api = new PetsApi();

  try {
    const data = await api.listLegacyPets();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**Array&lt;Pet&gt;**](Pet.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | A list of pets |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listPetVisits

> Array&lt;Visit&gt; listPetVisits(petId, since)

List the vet visits of a pet

### Example

```ts
import {
  Configuration,
  PetsApi,
} from 'petclinic-sdk-variant';
import type { ListPetVisitsRequest } from 'petclinic-sdk-variant';

async function example() {
  console.log("🚀 Testing petclinic-sdk-variant SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
    // To configure API key authorization: apiKeyHeader
    apiKey: "YOUR API KEY",
  });
  const api = new PetsApi(config);

  const body = {
    // number | Identifier of the pet
    petId: 1,
    // string | Only visits on or after this date (optional)
    since: 2013-10-20,
  } satisfies ListPetVisitsRequest;

  try {
    const data = await api.listPetVisits(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **petId** | `number` | Identifier of the pet | [Defaults to `undefined`] |
| **since** | `string` | Only visits on or after this date | [Optional] [Defaults to `undefined`] |

### Return type

[**Array&lt;Visit&gt;**](Visit.md)

### Authorization

[bearerAuth](../README.md#bearerAuth), [apiKeyHeader](../README.md#apiKeyHeader)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Visits |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listPets

> Array&lt;Pet&gt; listPets(species, limit)

List pets

Returns pets registered at the clinic, optionally filtered by species.

### Example

```ts
import {
  Configuration,
  PetsApi,
} from 'petclinic-sdk-variant';
import type { ListPetsRequest } from 'petclinic-sdk-variant';

async function example() {
  console.log("🚀 Testing petclinic-sdk-variant SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
    // To configure API key authorization: apiKeyHeader
    apiKey: "YOUR API KEY",
  });
  const api = new PetsApi(config);

  const body = {
    // Species | Only return pets of this species (optional)
    species: ...,
    // number | Maximum number of pets to return (optional)
    limit: 20,
  } satisfies ListPetsRequest;

  try {
    const data = await api.listPets(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **species** | `Species` | Only return pets of this species | [Optional] [Defaults to `undefined`] [Enum: dog, cat, bird, rabbit] |
| **limit** | `number` | Maximum number of pets to return | [Optional] [Defaults to `undefined`] |

### Return type

[**Array&lt;Pet&gt;**](Pet.md)

### Authorization

[bearerAuth](../README.md#bearerAuth), [apiKeyHeader](../README.md#apiKeyHeader)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | A list of pets |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

