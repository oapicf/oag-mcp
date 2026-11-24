# PetsApi

All URIs are relative to *https://petstore.example.com/v1*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**createPet**](PetsApi.md#createpet) | **POST** /pets | Register a pet |
| [**getPetById**](PetsApi.md#getpetbyid) | **GET** /pets/{petId} | Get a pet |
| [**listPets**](PetsApi.md#listpets) | **GET** /pets | List pets |



## createPet

> Pet createPet(newPet)

Register a pet

### Example

```ts
import {
  Configuration,
  PetsApi,
} from '';
import type { CreatePetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({ 
    // To configure OAuth2 access token for authorization: petstoreOAuth application
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

[petstoreOAuth application](../README.md#petstoreOAuth-application)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | The registered pet |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getPetById

> Pet getPetById(petId)

Get a pet

### Example

```ts
import {
  Configuration,
  PetsApi,
} from '';
import type { GetPetByIdRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({ 
    // To configure OAuth2 access token for authorization: petstoreOAuth application
    accessToken: "YOUR ACCESS TOKEN",
  });
  const api = new PetsApi(config);

  const body = {
    // number
    petId: 56,
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
| **petId** | `number` |  | [Defaults to `undefined`] |

### Return type

[**Pet**](Pet.md)

### Authorization

[petstoreOAuth application](../README.md#petstoreOAuth-application)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | The pet |  -  |
| **404** | No such pet |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listPets

> Array&lt;Pet&gt; listPets(limit)

List pets

### Example

```ts
import {
  Configuration,
  PetsApi,
} from '';
import type { ListPetsRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({ 
    // To configure OAuth2 access token for authorization: petstoreOAuth application
    accessToken: "YOUR ACCESS TOKEN",
  });
  const api = new PetsApi(config);

  const body = {
    // number | Maximum number of pets to return (optional)
    limit: 56,
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
| **limit** | `number` | Maximum number of pets to return | [Optional] [Defaults to `undefined`] |

### Return type

[**Array&lt;Pet&gt;**](Pet.md)

### Authorization

[petstoreOAuth application](../README.md#petstoreOAuth-application)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | The pets |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

